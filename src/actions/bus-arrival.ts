import streamDeck, { action, DidReceiveSettingsEvent, SingletonAction, WillAppearEvent, WillDisappearEvent, KeyAction, DialAction, KeyDownEvent, KeyUpEvent } from "@elgato/streamdeck";
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

type BusSettings = {
	stopCode?: string;
	stopCode2?: string;
	stopCode3?: string;
	stopCode4?: string;
	stopCode5?: string;
	lineFilters?: string;
	dummyData?: boolean;
	lineConfigs?: string;
	busColor1?: string;
	busColor2?: string;
};

interface BusData {
	lineId: string;
	etaMinutes: string | null;
	destination: string;
	routeCode: string;
	scheduledTerminalDepartures: string[];
}

@action({ UUID: "com.miketsakgr.oasa-bus.arrival" })
export class BusArrival extends SingletonAction<BusSettings> {
	private intervals: Map<string, NodeJS.Timeout> = new Map();
	private keyDownTimes: Map<string, number> = new Map();
	private lastData: Map<string, BusData[]> = new Map();
	private currentPage: Map<string, number> = new Map();
	private isAnimating: Map<string, boolean> = new Map();
	private lastFetchTime: Map<string, number> = new Map();
	private activeStopIndex: Map<string, number> = new Map();
	private lastTapTime: Map<string, number> = new Map();
	private holdAnimationInterval: Map<string, NodeJS.Timeout> = new Map();
	private hasHardRefreshed: Map<string, boolean> = new Map();
	private hasDoubleTapped: Map<string, boolean> = new Map();
	private singleTapTimeout: Map<string, NodeJS.Timeout> = new Map();

	private getActiveStopCode(settings: BusSettings, index: number): string | undefined {
		const stops = [settings.stopCode, settings.stopCode2, settings.stopCode3, settings.stopCode4, settings.stopCode5];
		return stops[index];
	}

	override async onWillAppear(ev: WillAppearEvent<BusSettings>): Promise<void> {
		let settings = ev.payload.settings;
		if (!settings.stopCode) {
			settings = { ...settings, stopCode: "070106" };
			await ev.action.setSettings(settings);
		}
		this.currentPage.set(ev.action.id, 0);
		this.activeStopIndex.set(ev.action.id, 0);
		await this.fetchAndUpdate(ev.action, settings);
		this.startPolling(ev.action.id, ev.action, settings);
	}

	override onWillDisappear(ev: WillDisappearEvent<BusSettings>): void | Promise<void> {
		this.stopPolling(ev.action.id);
		this.keyDownTimes.delete(ev.action.id);
		this.lastData.delete(ev.action.id);
		this.currentPage.delete(ev.action.id);
		this.isAnimating.delete(ev.action.id);
		this.lastFetchTime.delete(ev.action.id);
		this.activeStopIndex.delete(ev.action.id);
		this.lastTapTime.delete(ev.action.id);
		const holdInterval = this.holdAnimationInterval.get(ev.action.id);
		if (holdInterval) {
			clearInterval(holdInterval);
			this.holdAnimationInterval.delete(ev.action.id);
		}
		this.hasHardRefreshed.delete(ev.action.id);
		this.hasDoubleTapped.delete(ev.action.id);
		const pendingTap = this.singleTapTimeout.get(ev.action.id);
		if (pendingTap) {
			clearTimeout(pendingTap);
			this.singleTapTimeout.delete(ev.action.id);
		}
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<BusSettings>): Promise<void> {
		this.stopPolling(ev.action.id);
		const settings = ev.payload.settings;
		if (settings.stopCode) {
			await this.fetchAndUpdate(ev.action, settings);
			this.startPolling(ev.action.id, ev.action, settings);
		} else {
			if (ev.action.isKey()) {
				await ev.action.setTitle("Set\nStop");
			}
		}
	}

	override async onKeyDown(ev: KeyDownEvent<BusSettings>): Promise<void> {
		const now = Date.now();
		this.keyDownTimes.set(ev.action.id, now);
		
		const settings = ev.payload.settings;
		if (!settings.stopCode) return;
		if (this.isAnimating.get(ev.action.id)) return; // Ignore input while animating

		// Check if a single tap is currently pending (waiting for disambiguation)
		const pendingTap = this.singleTapTimeout.get(ev.action.id);
		if (pendingTap) {
			// A second tap occurred before the 250ms window expired!
			clearTimeout(pendingTap);
			this.singleTapTimeout.delete(ev.action.id);
			
			this.hasDoubleTapped.set(ev.action.id, true);
			
			// Handle Double Tap: Cycle to next configured stop
			let currentIndex = this.activeStopIndex.get(ev.action.id) || 0;
			let stops = [settings.stopCode, settings.stopCode2, settings.stopCode3, settings.stopCode4, settings.stopCode5];
			
			if (settings.dummyData) {
				// Inject fake stops so double-tap testing works even if no secondary stops are set
				stops = ["DUMMY1", "DUMMY2", "DUMMY3", undefined, undefined];
			}
			
			// Find next configured stop
			let nextIndex = (currentIndex + 1) % 5;
			while (nextIndex !== currentIndex && (!stops[nextIndex] || stops[nextIndex]!.trim() === "")) {
				nextIndex = (nextIndex + 1) % 5;
			}
			
			if (nextIndex !== currentIndex && stops[nextIndex] && stops[nextIndex]!.trim() !== "") {
				this.activeStopIndex.set(ev.action.id, nextIndex);
				this.currentPage.set(ev.action.id, 0);
				
				if (ev.action.isKey()) {
					// Briefly show which stop we switched to before fetching
					await ev.action.setTitle(`Stop\n${nextIndex + 1}`);
				}
				
				this.stopPolling(ev.action.id);
				await this.fetchAndUpdate(ev.action, settings);
				this.startPolling(ev.action.id, ev.action, settings);
				return;
			}
		}

		this.hasDoubleTapped.set(ev.action.id, false);
		this.hasHardRefreshed.set(ev.action.id, false);

		// Start hold animation for Hard Refresh
		const holdInterval = setInterval(async () => {
			const elapsed = Date.now() - now;
			if (elapsed >= 5000) {
				clearInterval(holdInterval);
				this.holdAnimationInterval.delete(ev.action.id);
				this.hasHardRefreshed.set(ev.action.id, true);
				
				// Hard refresh triggered
				this.currentPage.set(ev.action.id, 0);
				
				if (ev.action.isKey()) {
					await ev.action.setTitle("Refreshed!");
					setTimeout(() => ev.action.setTitle(""), 2000);
				}
				
				this.stopPolling(ev.action.id);
				await this.fetchAndUpdate(ev.action, settings);
				this.startPolling(ev.action.id, ev.action, settings);
				return;
			}
			
			// Draw progress animation frame
			if (ev.action.isKey()) {
				const progress = elapsed / 5000;
				const currentData = this.lastData.get(ev.action.id) || [];
				let baseSvg = this.generateLedSVG(currentData, this.currentPage.get(ev.action.id) || 0, this.currentPage.get(ev.action.id) || 0, 0, settings.lineConfigs, settings.busColor1, settings.busColor2, ev.action.id);
				
				// Inject animation overlay
				const overlay = `
					<rect x="0" y="0" width="144" height="144" fill="#0F172A" opacity="0.85" />
					<circle cx="72" cy="72" r="${progress * 110}" fill="#10B981" />
					<text x="72" y="68" font-family="Arial, sans-serif" font-size="14" font-weight="bold" fill="#FFFFFF" text-anchor="middle">Hold 5s</text>
					<text x="72" y="86" font-family="Arial, sans-serif" font-size="12" font-weight="bold" fill="#FFFFFF" text-anchor="middle">to refresh</text>
				`;
				const animSvg = baseSvg.replace("</svg>", overlay + "</svg>");
				await ev.action.setImage(`data:image/svg+xml;charset=utf8,${encodeURIComponent(animSvg)}`);
			}
		}, 100);
		this.holdAnimationInterval.set(ev.action.id, holdInterval);
	}

	override async onKeyUp(ev: KeyUpEvent<BusSettings>): Promise<void> {
		this.keyDownTimes.delete(ev.action.id);

		const holdInterval = this.holdAnimationInterval.get(ev.action.id);
		if (holdInterval) {
			clearInterval(holdInterval);
			this.holdAnimationInterval.delete(ev.action.id);
		}

		const hardRefreshed = this.hasHardRefreshed.get(ev.action.id) || false;
		const doubleTapped = this.hasDoubleTapped.get(ev.action.id) || false;
		
		const settings = ev.payload.settings;
		const data = this.lastData.get(ev.action.id) || [];

		if (!hardRefreshed && !doubleTapped) {
			// Redraw normal state immediately to clear any potential hold-animation overlay frame
			const page = this.currentPage.get(ev.action.id) || 0;
			const svg = this.generateLedSVG(data, page, page, 0, settings.lineConfigs, settings.busColor1, settings.busColor2, ev.action.id);
			if (ev.action.isKey()) {
				// Fire-and-forget for snappiness
				ev.action.setImage(`data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`).catch(console.error);
			}

			// Defer the single tap (pagination) to ensure a double tap doesn't follow
			const timeout = setTimeout(async () => {
				this.singleTapTimeout.delete(ev.action.id);
				
				// It's a genuine single tap! Paginate.
				if (data.length > 1) {
					let currentPage = this.currentPage.get(ev.action.id) || 0;
					const totalPages = Math.ceil((data.length + 1) / 2);
					let newPage = (currentPage + 1) % totalPages;
					
					if (ev.action.isKey()) {
						await this.animateScroll(ev.action, data, currentPage, newPage, settings);
					}
					this.currentPage.set(ev.action.id, newPage);
				}
			}, 250);
			this.singleTapTimeout.set(ev.action.id, timeout);
			
		} else if (hardRefreshed) {
			// If we hard refreshed, just clear the overlay
			const page = this.currentPage.get(ev.action.id) || 0;
			const svg = this.generateLedSVG(data, page, page, 0, settings.lineConfigs, settings.busColor1, settings.busColor2, ev.action.id);
			if (ev.action.isKey()) {
				await ev.action.setImage(`data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`);
			}
		}
	}

	private async animateScroll(action: KeyAction<BusSettings>, data: BusData[], oldPage: number, newPage: number, settings: BusSettings) {
		this.isAnimating.set(action.id, true);
		
		const frames = 12;
		const totalScrollDistance = 144;
		
		// Ease-out function for smooth scrolling
		const easeOutQuad = (t: number) => t * (2 - t);

		for (let i = 1; i <= frames; i++) {
			const progress = i / frames;
			const currentScroll = easeOutQuad(progress) * totalScrollDistance;
			
			const svg = this.generateLedSVG(data, oldPage, newPage, currentScroll, settings.lineConfigs, settings.busColor1, settings.busColor2, action.id);
			await action.setImage(`data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`);
			
			// wait ~25ms per frame
			await new Promise(r => setTimeout(r, 25));
		}

		this.isAnimating.set(action.id, false);
	}

	private startPolling(actionId: string, actionObj: KeyAction<BusSettings> | DialAction<BusSettings>, settings: BusSettings) {
		const interval = setInterval(() => {
			this.fetchAndUpdate(actionObj, settings);
		}, 60000); // 60-second polling
		this.intervals.set(actionId, interval);
	}

	private stopPolling(actionId: string) {
		const interval = this.intervals.get(actionId);
		if (interval) {
			clearInterval(interval);
			this.intervals.delete(actionId);
		}
	}

	private async fetchAndUpdate(actionObj: KeyAction<BusSettings> | DialAction<BusSettings>, settings: BusSettings) {
		if (actionObj.isKey()) {
			const loadingSvg = this.generateLoadingSVG();
			await actionObj.setImage(`data:image/svg+xml;charset=utf8,${encodeURIComponent(loadingSvg)}`);
		}

		let data: BusData[] = [];
		let hasError = false;
		let errorMessage = "";

		if (settings.dummyData) {
			const activeIndex = this.activeStopIndex.get(actionObj.id) || 0;
			if (activeIndex === 0) {
				data = [
					{ lineId: "856", etaMinutes: "5", destination: "ΠΡΟΣ ΑΙΓΑΛΕΩ", routeCode: "1234", scheduledTerminalDepartures: ["21:10"] },
					{ lineId: "A15", etaMinutes: null, destination: "ΠΡΟΣ ΣΤΑΘ.ΛΑΡΙΣΗΣ", routeCode: "5678", scheduledTerminalDepartures: ["21:15"] },
					{ lineId: "815", etaMinutes: "25", destination: "ΠΡΟΣ ΓΟΥΔΗ", routeCode: "9012", scheduledTerminalDepartures: ["21:45"] }
				];
			} else if (activeIndex === 1) {
				data = [
					{ lineId: "040", etaMinutes: "2", destination: "ΠΕΙΡΑΙΑΣ - ΣΥΝΤΑΓΜΑ", routeCode: "111", scheduledTerminalDepartures: [] },
					{ lineId: "049", etaMinutes: "10", destination: "ΠΕΙΡΑΙΑΣ - ΟΜΟΝΟΙΑ", routeCode: "222", scheduledTerminalDepartures: [] }
				];
			} else {
				data = [
					{ lineId: "X95", etaMinutes: "15", destination: "ΣΥΝΤΑΓΜΑ - ΑΕΡΟΔΡΟΜΙΟ", routeCode: "333", scheduledTerminalDepartures: [] }
				];
			}
		} else {
			const filters = (settings.lineFilters || "").split(',').map(s => s.trim()).filter(s => s.length > 0);
			try {
				const activeIndex = this.activeStopIndex.get(actionObj.id) || 0;
				const currentStopCode = this.getActiveStopCode(settings, activeIndex) || settings.stopCode;
				
				// 1. Fetch live arrivals
				const res = await fetch(`http://telematics.oasa.gr/api/?act=getStopArrivals&p1=${currentStopCode}`, { signal: AbortSignal.timeout(8000) });
				
				if (!res.ok) {
					hasError = true;
					errorMessage = `HTTP Sφάλμα: ${res.status}`;
				} else {
					const rawArrivalsText = await res.text();
					try {
						const rawArrivals = JSON.parse(rawArrivalsText);

						if (Array.isArray(rawArrivals)) {
							if (rawArrivals.length > 0) {
								// 2. Filter lines
								let selected = rawArrivals;
								if (filters.length > 0) {
									selected = rawArrivals.filter((arr: any) => filters.includes(arr.line_id));
								}

								// Deduplicate by line_id (we only want one panel per line)
								const uniqueLines: any[] = [];
								const seen = new Set();
								for (const arr of selected) {
									if (!seen.has(arr.line_id)) {
										seen.add(arr.line_id);
										uniqueLines.push(arr);
									}
								}

								// For fetching schedules, we can fetch for all unique lines to support pagination
								const linesToFetch = uniqueLines.slice(0, 6); // Max 6 lines to avoid spamming the API

								// 3. For each line, fetch scheduled data
								for (const arrival of linesToFetch) {
									let terminalDepartures: string[] = [];
									
									try {
										const schedRes = await fetch(`http://telematics.oasa.gr/api/?act=getDailySchedule&line_code=${arrival.route_code}`, { signal: AbortSignal.timeout(3000) });
										const schedule = await schedRes.json();
										
										if (Array.isArray(schedule) && schedule.length > 0) {
											const now = new Date();
											const currentMinutes = now.getHours() * 60 + now.getMinutes();
											
											const futureDeps = schedule.filter((s: any) => {
												const parts = s.sdc_code.split(':');
												if (parts.length < 2) return false;
												const [h, m] = parts.map(Number);
												return (h * 60 + m) > currentMinutes;
											});
											
											if (futureDeps.length >= 2) {
												terminalDepartures = [futureDeps[0].sdc_code, futureDeps[1].sdc_code];
											} else if (futureDeps.length === 1) {
												terminalDepartures = [futureDeps[0].sdc_code];
											}
										}
									} catch (e) {
										console.log("Schedule API failed/timeout, cannot fetch schedule data", e);
									}

									// If btime2 is effectively empty or 0, we can treat it as null to trigger fallback
									let liveEta = null;
									if (arrival.btime2 && arrival.btime2.trim() !== "") {
										liveEta = arrival.btime2;
									}

									data.push({
										lineId: arrival.line_id,
										etaMinutes: liveEta,
										destination: "ΠΡΟΣ " + (arrival.dest_nme || "ΤΕΡΜΑ"),
										routeCode: arrival.route_code,
										scheduledTerminalDepartures: terminalDepartures
									});
								}
								
								// Sort data (Live first, then Scheduled, then by time)
								data.sort((a, b) => {
									const aIsLive = a.etaMinutes !== null;
									const bIsLive = b.etaMinutes !== null;

									if (aIsLive && !bIsLive) return -1;
									if (!aIsLive && bIsLive) return 1;

									if (aIsLive && bIsLive) {
										return parseInt(a.etaMinutes!) - parseInt(b.etaMinutes!);
									} else {
										const aDep = a.scheduledTerminalDepartures[0] || "23:59";
										const bDep = b.scheduledTerminalDepartures[0] || "23:59";
										return aDep.localeCompare(bDep);
									}
								});
							}
						} else {
							// Not an array - likely an error message from OASA
							hasError = true;
							errorMessage = "Άκυρα δεδομένα (Μη αναμενόμενη μορφή)";
						}
					} catch (e) {
						hasError = true;
						errorMessage = "Άκυρα δεδομένα από OASA";
					}
				}
			} catch (err: any) {
				console.error("API Error:", err);
				hasError = true;
				if (err.name === 'TimeoutError') {
					errorMessage = "Timeout: Ο OASA δεν απαντά";
				} else {
					errorMessage = "Εκτός λειτουργίας (OASA Down)";
				}
			}
		}
		
		this.lastData.set(actionObj.id, data);
		if (!hasError && data.length > 0) {
			this.lastFetchTime.set(actionObj.id, Date.now());
		}
		const page = this.currentPage.get(actionObj.id) || 0;
		
		if (actionObj.isKey()) {
			await actionObj.setTitle(""); 
			if (hasError) {
				const svg = this.generateErrorSVG(errorMessage);
				await actionObj.setImage(`data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`);
			} else {
				const svg = this.generateLedSVG(data, page, page, 0, settings.lineConfigs, settings.busColor1, settings.busColor2, actionObj.id);
				await actionObj.setImage(`data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`);
			}
		}
	}

	private generateLoadingSVG(): string {
		const width = 144;
		const height = 144;
		let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`;
		svg += `<rect width="100%" height="100%" fill="#0A0A0A" />`;
		const cx = 72; const cy = 72; const r = 24;
		svg += `
			<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#222" stroke-width="4" />
			<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#FFBF00" stroke-width="4" stroke-dasharray="40 110" stroke-linecap="round">
				<animateTransform attributeName="transform" type="rotate" from="0 ${cx} ${cy}" to="360 ${cx} ${cy}" dur="1.2s" repeatCount="indefinite" />
			</circle>
		`;
		svg += `</svg>`;
		return svg;
	}

	private generateErrorSVG(errorMessage: string): string {
		const width = 144;
		const height = 144;
		let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`;
		svg += `<rect width="100%" height="100%" fill="#1D1515" />`;
		svg += `
			<path d="M72 35 L40 90 L104 90 Z" fill="none" stroke="#F2B8B5" stroke-width="4" stroke-linejoin="round" />
			<line x1="72" y1="55" x2="72" y2="72" stroke="#F2B8B5" stroke-width="4" stroke-linecap="round" />
			<circle cx="72" cy="82" r="2.5" fill="#F2B8B5" />
			<text x="72" y="110" font-family="sans-serif" font-size="9" font-weight="bold" fill="#F2B8B5" text-anchor="middle">ΣΦΑΛΜΑ OASA API</text>
		`;
		
		const words = errorMessage.split(' ');
		const half = Math.ceil(words.length / 2);
		const line1 = words.slice(0, half).join(' ');
		const line2 = words.slice(half).join(' ');
		if (line2.length > 0) {
			svg += `<text x="72" y="124" font-family="sans-serif" font-size="6" font-weight="normal" fill="#C4C7C5" text-anchor="middle">${line1}</text>`;
			svg += `<text x="72" y="132" font-family="sans-serif" font-size="6" font-weight="normal" fill="#C4C7C5" text-anchor="middle">${line2}</text>`;
		} else {
			svg += `<text x="72" y="124" font-family="sans-serif" font-size="6" font-weight="normal" fill="#C4C7C5" text-anchor="middle">${line1}</text>`;
		}

		svg += `</svg>`;
		return svg;
	}

	private generateLedSVG(allLines: BusData[], page1: number, page2: number, offsetY: number, rawConfigs?: string, busColor1?: string, busColor2?: string, actionId?: string): string {
		const width = 144;
		const height = 144;
		
		let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`;

		// 1. Absolute Reset (The Artifact Killer)
		// We use a solid 144x144 opaque dark hex color as the base to prevent any ghosting or bleeding
		// FIX: Use 144 instead of 100% to avoid Qt SVG parser treating it as 100 pixels!
		svg += `<rect width="144" height="144" fill="#0F172A" />`;

		if (allLines.length === 0) {
			svg += `<text x="72" y="72" font-family="Consolas, monospace" font-size="14" font-weight="bold" fill="#FFBF00" text-anchor="middle">NO DATA</text>`;
			svg += `</svg>`;
			return svg;
		}

		let fetchTime = 0;
		if (actionId && this.lastFetchTime.has(actionId)) {
			fetchTime = this.lastFetchTime.get(actionId) || 0;
		}

		// Scrolling Group
		svg += `<g transform="translate(0, ${-offsetY})">`;
		
		const panelHeight = 60;
		const c1 = busColor1 || "#004A77";
		const c2 = busColor2 || "#E3963E";
		
		// Parse configs once
		const configs = new Map<string, { color: string, text: string }>();
		if (rawConfigs) {
			const lines = rawConfigs.split('\n');
			for (const l of lines) {
				const parts = l.split(',');
				if (parts.length >= 3) {
					configs.set(parts[0].trim(), { color: parts[1].trim(), text: parts[2].trim() });
				}
			}
		}

		const drawSeparator = (yPos: number) => {
			return `<line x1="8" y1="${yPos}" x2="136" y2="${yPos}" stroke="#0077FF" stroke-width="1.5" />`;
		};

		const getSlotType = (pageIndex: number, slotIndex: number): 'bus' | 'credits' | 'empty' => {
			const index = pageIndex * 2 + slotIndex;
			if (index < allLines.length) return 'bus';
			if (index === allLines.length) return 'credits';
			return 'empty';
		};

		const drawCreditsBlock = (virtualIndex: number) => {
			const y = 6 + (virtualIndex * (panelHeight + 12)); 
			let timeStr = "--:--";
			if (fetchTime > 0) {
				const d = new Date(fetchTime);
				timeStr = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
			}
			
			return `
				<rect x="4" y="${y}" width="136" height="${panelHeight}" fill="#111B2C" rx="6" stroke="#1E293B" stroke-width="1" />
				<text x="72" y="${y + 24}" font-family="Arial, sans-serif" font-size="10" font-weight="bold" fill="#00AAFF" text-anchor="middle">Made by</text>
				<text x="72" y="${y + 38}" font-family="Consolas, monospace" font-size="12" font-weight="bold" fill="#FFFFFF" text-anchor="middle">miketsak.gr</text>
				<text x="72" y="${y + 52}" font-family="Arial, sans-serif" font-size="9" fill="#888888" text-anchor="middle">Updated: ${timeStr}</text>
			`;
		};

		const drawBlock = (line: BusData, virtualIndex: number) => {
			const y = 6 + (virtualIndex * (panelHeight + 12)); 
			const lineConf = configs.get(line.lineId);
			const defaultColor = (virtualIndex % 2 === 0) ? c1 : c2;
			const pillColor = lineConf ? lineConf.color : defaultColor;
			const pillText = lineConf ? lineConf.text : line.lineId;
			
			let blockSvg = ``;
			
			// 1. LEFT COLUMN (25%): Molded Line Block
			blockSvg += `
				<rect x="4" y="${y}" width="34" height="${panelHeight}" fill="${pillColor}" rx="6" />
				<text x="21" y="${y + 36}" font-family="Impact, Arial Black, sans-serif" font-size="16" font-weight="900" fill="#FFFFFF" text-anchor="middle" letter-spacing="1">${pillText}</text>
			`;

			// 2. CENTER COLUMN (40%): Live ETA LED Display
			let mainDisplay = "";
			let isScheduledFallback = false;
			let displayColor = "#FFBF00"; // Amber
			let displaySize = 36;
			let textYOffset = 46;

			if (line.etaMinutes !== null) {
				mainDisplay = `${parseInt(line.etaMinutes) || 0}`;
			} else {
				mainDisplay = line.scheduledTerminalDepartures[0] || "--:--";
				isScheduledFallback = true;
				displayColor = "#FFFFFF";
				displaySize = 16;
				textYOffset = 40;
			}

			// Retro digital clock icon above ETA
			blockSvg += `<text x="68" y="${y + 14}" font-family="Arial" font-size="10" fill="#666666" text-anchor="middle">⏱</text>`;

			blockSvg += `
				<text x="68" y="${y + textYOffset}" font-family="Consolas, Courier New, monospace" font-size="${displaySize}" font-weight="bold" fill="${displayColor}" text-anchor="middle" textLength="${isScheduledFallback ? 46 : 42}" lengthAdjust="spacingAndGlyphs">${mainDisplay}</text>
			`;

			if (isScheduledFallback) {
				blockSvg += `<text x="68" y="${y + 54}" font-family="Arial, sans-serif" font-size="9" fill="#888" text-anchor="middle" letter-spacing="1">SCHED</text>`;
			}

			// 3. RIGHT COLUMN (35%): Schedule Gold Card
			const rightAnchor = 136;
			const t1 = line.scheduledTerminalDepartures[0] || "--:--";
			const t2 = line.scheduledTerminalDepartures[1] || "";
			
			// Use solid OPAQUE hex colors for the background block
			blockSvg += `
				<rect x="92" y="${y + 2}" width="48" height="56" fill="#3d3321" rx="4" stroke="#4a3e26" stroke-width="1" />
				<text x="${rightAnchor}" y="${y + 16}" font-family="Consolas, monospace" font-size="10" font-weight="bold" fill="#FFE066" text-anchor="end">🚶 ${t1}</text>
				<text x="${rightAnchor}" y="${y + 32}" font-family="Consolas, monospace" font-size="10" font-weight="bold" fill="#B0A692" text-anchor="end">⏱ ${t2}</text>
				<text x="${116}" y="${y + 50}" font-family="Arial" font-size="9" fill="#888888" text-anchor="middle">📍 ΤΕΡΜΑ</text>
			`;
			
			return blockSvg;
		};

		// Render Page 1
		for (let slot = 0; slot < 2; slot++) {
			const type = getSlotType(page1, slot);
			if (type === 'bus') {
				svg += drawBlock(allLines[page1 * 2 + slot], slot);
			} else if (type === 'credits') {
				svg += drawCreditsBlock(slot);
			}
		}
		if (getSlotType(page1, 1) !== 'empty') {
			svg += drawSeparator(71);
		}

		// Render Page 2
		if (page1 !== page2) {
			for (let slot = 0; slot < 2; slot++) {
				const type = getSlotType(page2, slot);
				if (type === 'bus') {
					svg += drawBlock(allLines[page2 * 2 + slot], slot + 2);
				} else if (type === 'credits') {
					svg += drawCreditsBlock(slot + 2);
				}
			}
			if (getSlotType(page2, 1) !== 'empty') {
				svg += drawSeparator(71 + 144);
			}
		}

		svg += `</g>`;

		// Draw bottom bar for API Scan/Fetch Status (outside scroll group so it stays fixed)

		if (fetchTime > 0) {
			// Status bar background 
			svg += `<rect x="0" y="134" width="144" height="10" fill="#0F172A" />`;
			
			// Dot
			const isFresh = (Date.now() - fetchTime) < 70000;
			const statusColor = isFresh ? '#00FF00' : '#FFBF00';
			svg += `<circle cx="8" cy="139" r="2.5" fill="${statusColor}" />`;

			// Time text
			const d = new Date(fetchTime);
			const timeStr = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
			svg += `<text x="14" y="142" font-family="Arial" font-size="8" fill="#A0A0A0" text-anchor="start">Updated: ${timeStr}</text>`;
		}

		// Draw fixed pagination dots at the bottom right
		const maxPages = Math.ceil((allLines.length + 1) / 2);
		const activePage = (offsetY >= 72) ? page2 : page1; 

		if (maxPages > 1) {
			const dotsY = 139; 
			const dotSpacing = 12;
			const dotsWidth = (maxPages - 1) * dotSpacing;
			const startX = 144 - 6 - dotsWidth;

			for (let p = 0; p < maxPages; p++) {
				const isCurrent = p === activePage;
				const dotX = startX + (p * dotSpacing);
				const color = isCurrent ? "#00AAFF" : "#1e293b"; // Opaque solid inactive color
				svg += `<circle cx="${dotX}" cy="${dotsY}" r="2.5" fill="${color}" />`;
			}
		}

		svg += `</svg>`;
		return svg;
	}
}
