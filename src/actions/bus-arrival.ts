import streamDeck, { action, DidReceiveSettingsEvent, SingletonAction, WillAppearEvent, WillDisappearEvent, KeyAction, DialAction, KeyDownEvent, KeyUpEvent } from "@elgato/streamdeck";
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

type BusSettings = {
	stopCode?: string;
	lineFilters?: string;
	dummyData?: boolean;
	lineConfigs?: string;
};

interface BusData {
	lineId: string;
	etaMinutes: string;
	destination: string;
	routeCode: string;
	scheduledTerminalDepartures: string[];
	scheduledArrivalAtStop: string;
}

@action({ UUID: "com.miketsakgr.oasa-bus.arrival" })
export class BusArrival extends SingletonAction<BusSettings> {
	private intervals: Map<string, NodeJS.Timeout> = new Map();
	private keyDownTimes: Map<string, number> = new Map();
	private lastData: Map<string, BusData[]> = new Map();
	private currentPage: Map<string, number> = new Map();

	override async onWillAppear(ev: WillAppearEvent<BusSettings>): Promise<void> {
		let settings = ev.payload.settings;
		if (!settings.stopCode) {
			settings = { ...settings, stopCode: "070106" };
			await ev.action.setSettings(settings);
		}
		this.currentPage.set(ev.action.id, 0);
		await this.fetchAndUpdate(ev.action, settings);
		this.startPolling(ev.action.id, ev.action, settings);
	}

	override onWillDisappear(ev: WillDisappearEvent<BusSettings>): void | Promise<void> {
		this.stopPolling(ev.action.id);
		this.keyDownTimes.delete(ev.action.id);
		this.lastData.delete(ev.action.id);
		this.currentPage.delete(ev.action.id);
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

	override onKeyDown(ev: KeyDownEvent<BusSettings>): void | Promise<void> {
		this.keyDownTimes.set(ev.action.id, Date.now());
	}

	override async onKeyUp(ev: KeyUpEvent<BusSettings>): Promise<void> {
		const downTime = this.keyDownTimes.get(ev.action.id);
		if (downTime) {
			const elapsed = Date.now() - downTime;
			this.keyDownTimes.delete(ev.action.id);
			
			const settings = ev.payload.settings;
			if (!settings.stopCode) return;

			if (elapsed >= 500) {
				// Long press: Force API Refresh
				this.currentPage.set(ev.action.id, 0);
				if (ev.action.isKey()) {
					await ev.action.setTitle("");
				}
				await this.fetchAndUpdate(ev.action, settings);
				
				this.stopPolling(ev.action.id);
				this.startPolling(ev.action.id, ev.action, settings);
			} else {
				// Short press: Paginate through buses
				const data = this.lastData.get(ev.action.id) || [];
				let page = this.currentPage.get(ev.action.id) || 0;
				
				// Advance page
				page++;
				if (page * 2 >= data.length) {
					page = 0; // Wrap around
				}
				this.currentPage.set(ev.action.id, page);

				// Re-render SVG immediately without fetching
				if (ev.action.isKey()) {
					await ev.action.setTitle("");
					const svg = this.generateLegoPolySVG(data, page, settings.lineConfigs);
					await ev.action.setImage(`data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`);
				}
			}
		}
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
			// Bypass API and use mock data
			data = [
				{
					lineId: "856",
					etaMinutes: "5",
					destination: "ΠΡΟΣ ΑΙΓΑΛΕΩ",
					routeCode: "1234",
					scheduledTerminalDepartures: ["21:10", "21:30"],
					scheduledArrivalAtStop: "21:03"
				},
				{
					lineId: "A15",
					etaMinutes: "12",
					destination: "ΠΡΟΣ ΣΤΑΘ.ΛΑΡΙΣΗΣ",
					routeCode: "5678",
					scheduledTerminalDepartures: ["21:15", "21:45"],
					scheduledArrivalAtStop: "21:10"
				},
				{
					lineId: "815",
					etaMinutes: "25",
					destination: "ΠΡΟΣ ΓΟΥΔΗ",
					routeCode: "9012",
					scheduledTerminalDepartures: ["21:45", "22:15"],
					scheduledArrivalAtStop: "21:30"
				}
			];
		} else {
			const filters = (settings.lineFilters || "").split(',').map(s => s.trim()).filter(s => s.length > 0);
			try {
				// 1. Fetch live arrivals
				const res = await fetch(`http://telematics.oasa.gr/api/?act=getStopArrivals&p1=${settings.stopCode}`, { signal: AbortSignal.timeout(8000) });
				
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
									let terminalDepartures = ["--:--", "--:--"];
									let arrivalAtStop = "--:--";
									
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
												terminalDepartures = [futureDeps[0].sdc_code, "--:--"];
											}

											const etaMins = parseInt(arrival.btime2) || 0;
											const arrivalTime = new Date(now.getTime() + etaMins * 60000);
											arrivalAtStop = `${arrivalTime.getHours().toString().padStart(2, '0')}:${arrivalTime.getMinutes().toString().padStart(2, '0')}`;
										}
									} catch (e) {
										console.log("Schedule API failed/timeout, cannot fetch schedule data", e);
									}

									data.push({
										lineId: arrival.line_id,
										etaMinutes: arrival.btime2,
										destination: "ΠΡΟΣ " + (arrival.dest_nme || "ΤΕΡΜΑ"),
										routeCode: arrival.route_code,
										scheduledTerminalDepartures: terminalDepartures,
										scheduledArrivalAtStop: arrivalAtStop
									});
								}
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
		const page = this.currentPage.get(actionObj.id) || 0;
		
		if (actionObj.isKey()) {
			await actionObj.setTitle(""); 
			if (hasError) {
				const svg = this.generateErrorSVG(errorMessage);
				await actionObj.setImage(`data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`);
			} else {
				const svg = this.generateLegoPolySVG(data, page, settings.lineConfigs);
				await actionObj.setImage(`data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`);
			}
		}
	}

	private generateLoadingSVG(): string {
		const width = 144;
		const height = 144;
		
		let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`;
		
		// Background
		svg += `<rect width="100%" height="100%" fill="#131314" />`;

		// Circular progress indicator with SVG animation
		const cx = 72;
		const cy = 72;
		const r = 24;

		svg += `
			<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#282A2F" stroke-width="4" />
			<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#A8C7FA" stroke-width="4" stroke-dasharray="40 110" stroke-linecap="round">
				<animateTransform attributeName="transform" type="rotate" from="0 ${cx} ${cy}" to="360 ${cx} ${cy}" dur="1.2s" repeatCount="indefinite" />
			</circle>
			
			<text x="72" y="120" font-family="sans-serif" font-size="8" font-weight="600" fill="#A8C7FA" text-anchor="middle" letter-spacing="1">ΦΟΡΤΩΣΗ...</text>
		`;
		
		svg += `</svg>`;
		return svg;
	}

	private generateErrorSVG(errorMessage: string): string {
		const width = 144;
		const height = 144;
		
		let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`;
		
		// Background (dark reddish)
		svg += `<rect width="100%" height="100%" fill="#1D1515" />`;

		// Warning Icon
		svg += `
			<path d="M72 35 L40 90 L104 90 Z" fill="none" stroke="#F2B8B5" stroke-width="4" stroke-linejoin="round" />
			<line x1="72" y1="55" x2="72" y2="72" stroke="#F2B8B5" stroke-width="4" stroke-linecap="round" />
			<circle cx="72" cy="82" r="2.5" fill="#F2B8B5" />
		`;

		// Error text
		svg += `
			<text x="72" y="110" font-family="sans-serif" font-size="9" font-weight="bold" fill="#F2B8B5" text-anchor="middle">ΣΦΑΛΜΑ OASA API</text>
		`;
		
		// Details text with word wrap simulation (split into two lines if needed)
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

	private generateLegoPolySVG(allLines: BusData[], page: number, rawConfigs?: string): string {
		const width = 144;
		const height = 144;
		
		// Parse Line Configs
		const configs = new Map<string, { color: string, text: string }>();
		if (rawConfigs) {
			const lines = rawConfigs.split('\n');
			for (const l of lines) {
				const parts = l.split(',');
				if (parts.length >= 3) {
					configs.set(parts[0].trim(), { 
						color: parts[1].trim(), 
						text: parts.slice(2).join(',').trim() 
					});
				}
			}
		}

		let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`;
		
		// 1. Background (Solid Dark)
		svg += `<rect width="100%" height="100%" fill="#0E1114" />`;

		// Calculate pagination
		const linesToShow = allLines.slice(page * 2, page * 2 + 2);

		if (linesToShow.length === 0) {
			svg += `<text x="72" y="72" font-family="sans-serif" font-size="12" font-weight="900" fill="#E2E2E2" text-anchor="middle">NO DATA</text>`;
			svg += `</svg>`;
			return svg;
		}

		// 2. Draw "Lego Bricks" (Panels)
		// We have 144px height. Leave 8px at the bottom for pagination dots.
		// Height available: 136px. Two blocks -> 64px each + 4px gap.
		// Block 1: y = 4
		// Block 2: y = 72
		const panelHeight = 64;
		const defaultColors = ["#1D4E89", "#8D2D22", "#006B3C", "#E3963E"];
		
		for (let i = 0; i < linesToShow.length; i++) {
			const line = linesToShow[i];
			const y = 4 + (i * (panelHeight + 4));
			
			// Resolve configurations
			const lineConf = configs.get(line.lineId);
			const pillColor = lineConf ? lineConf.color : defaultColors[i % defaultColors.length];
			const pillText = lineConf ? lineConf.text : line.lineId;
			const textColor = "#FFFFFF";

			// Panel BG (Solid Color Brick)
			svg += `<rect x="4" y="${y}" width="136" height="${panelHeight}" fill="${pillColor}" rx="4" />`;
			
			// --- LEFT: The ID Block (Distinct Square) ---
			// We overlay a translucent dark box to create a distinct geometric block for the ID
			svg += `
				<rect x="8" y="${y + 8}" width="40" height="48" fill="rgba(0,0,0,0.3)" rx="4" />
				<text x="28" y="${y + 40}" font-family="Arial, Helvetica, sans-serif" font-size="20" font-weight="900" fill="${textColor}" text-anchor="middle">${pillText}</text>
			`;

			// --- CENTER: The ETA Block (Massive Number) ---
			// Draw just the number, huge and bold, absolute focal point
			let eta = parseInt(line.etaMinutes) || 0;
			svg += `
				<text x="82" y="${y + 48}" font-family="Arial, Helvetica, sans-serif" font-size="44" font-weight="900" fill="${textColor}" text-anchor="middle">${eta}</text>
			`;

			// --- RIGHT: The Schedule Block (Crisp stacked times) ---
			// Draw two scheduled times, stacked vertically on the right edge
			const rightX = 132; // anchor to the right
			const t1 = line.scheduledTerminalDepartures[0] || "--:--";
			const t2 = line.scheduledTerminalDepartures[1] || "--:--";

			svg += `
				<text x="${rightX}" y="${y + 28}" font-family="monospace, sans-serif" font-size="13" font-weight="bold" fill="rgba(255,255,255,0.85)" text-anchor="end">${t1}</text>
				<text x="${rightX}" y="${y + 50}" font-family="monospace, sans-serif" font-size="13" font-weight="bold" fill="rgba(255,255,255,0.65)" text-anchor="end">${t2}</text>
			`;
		}

		// Draw pagination dots at the bottom if there are multiple pages
		const maxPages = Math.ceil(allLines.length / 2);
		if (maxPages > 1) {
			const dotsY = 141; // At the very bottom
			const dotSpacing = 10;
			const dotsWidth = (maxPages - 1) * dotSpacing;
			const startX = 72 - (dotsWidth / 2);

			for (let p = 0; p < maxPages; p++) {
				const isCurrent = p === page;
				const dotX = startX + (p * dotSpacing);
				const color = isCurrent ? "#FFFFFF" : "rgba(255,255,255,0.3)";
				svg += `<circle cx="${dotX}" cy="${dotsY}" r="2" fill="${color}" />`;
			}
		}

		svg += `</svg>`;
		return svg;
	}
}
