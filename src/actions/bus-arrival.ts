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

interface RouteInfo {
	lineId: string;
	lineCode: string;
	routeDescr: string;
	lineDescr: string;
}

interface StopLineInfo {
	lineId: string;
	lineCode: string;
	routeDescr: string;
	lineDescr: string;
	routeCode: string;
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
	private loadingAnimationInterval: Map<string, NodeJS.Timeout> = new Map();
	private loadingDelayTimeout: Map<string, NodeJS.Timeout> = new Map();
	private stopRoutesCache: Map<string, { timestamp: number; routes: Map<string, RouteInfo>; lines: StopLineInfo[] }> = new Map();

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
		await this.fetchAndUpdate(ev.action, settings, true);
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
		this.stopLoadingAnimation(ev.action.id);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<BusSettings>): Promise<void> {
		this.stopPolling(ev.action.id);
		const settings = ev.payload.settings;
		if (settings.stopCode) {
			await this.fetchAndUpdate(ev.action, settings, true);
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
				await this.fetchAndUpdate(ev.action, settings, true);
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
				await this.fetchAndUpdate(ev.action, settings, true);
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
					<rect x="0" y="0" width="144" height="144" fill="#020617" opacity="0.85" />
					<circle cx="72" cy="72" r="${progress * 110}" fill="#10B981" />
					<text x="72" y="68" font-family="Inter, Roboto, sans-serif" font-size="14" font-weight="900" fill="#FFFFFF" text-anchor="middle">Hold 5s</text>
					<text x="72" y="86" font-family="Inter, Roboto, sans-serif" font-size="12" font-weight="900" fill="#FFFFFF" text-anchor="middle">to refresh</text>
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
			this.fetchAndUpdate(actionObj, settings, false);
		}, 90000); // 90-second (1:30 min) polling
		this.intervals.set(actionId, interval);
	}

	private stopPolling(actionId: string) {
		const interval = this.intervals.get(actionId);
		if (interval) {
			clearInterval(interval);
			this.intervals.delete(actionId);
		}
	}

	private startLoadingAnimation(actionObj: KeyAction<BusSettings> | DialAction<BusSettings>) {
		if (!actionObj.isKey()) return;
		this.stopLoadingAnimation(actionObj.id);

		let frame = 0;
		const initialSvg = this.generateLoadingSVG(0, 0.6);
		actionObj.setImage(`data:image/svg+xml;charset=utf8,${encodeURIComponent(initialSvg)}`).catch(() => {});

		const loadingInterval = setInterval(async () => {
			frame++;
			const rotation = (frame * 18) % 360;
			const pulse = 0.2 + (Math.sin(frame * 0.25) + 1) * 0.2;
			const loadingSvg = this.generateLoadingSVG(rotation, pulse);
			await actionObj.setImage(`data:image/svg+xml;charset=utf8,${encodeURIComponent(loadingSvg)}`).catch(() => {});
		}, 100); // ~10fps
		this.loadingAnimationInterval.set(actionObj.id, loadingInterval);
	}

	private stopLoadingAnimation(actionId: string) {
		const timer = this.loadingDelayTimeout.get(actionId);
		if (timer) {
			clearTimeout(timer);
			this.loadingDelayTimeout.delete(actionId);
		}
		const interval = this.loadingAnimationInterval.get(actionId);
		if (interval) {
			clearInterval(interval);
			this.loadingAnimationInterval.delete(actionId);
		}
	}

	private async fetchAndUpdate(actionObj: KeyAction<BusSettings> | DialAction<BusSettings>, settings: BusSettings, isExplicit: boolean = false) {
		const existingData = this.lastData.get(actionObj.id);
		const hasData = existingData !== undefined && existingData.length > 0;

		if (!hasData || isExplicit) {
			// Initial load or user action: show loading indicator immediately
			this.startLoadingAnimation(actionObj);
		} else {
			// Background polling: keep previous display and only show loader if API hangs (>2000ms)
			const timer = setTimeout(() => {
				this.startLoadingAnimation(actionObj);
			}, 2000);
			this.loadingDelayTimeout.set(actionObj.id, timer);
		}

		let data: BusData[] = [];
		let hasError = false;
		let errorMessage = "";

		if (settings.dummyData) {
			const activeIndex = this.activeStopIndex.get(actionObj.id) || 0;
			if (activeIndex === 0) {
				data = [
					{ lineId: "856", etaMinutes: "5", destination: "ΠΡΟΣ ΑΙΓΑΛΕΩ", routeCode: "1234", scheduledTerminalDepartures: ["21:10", "21:40"] },
					{ lineId: "A15", etaMinutes: null, destination: "ΠΡΟΣ ΣΤΑΘ.ΛΑΡΙΣΗΣ", routeCode: "5678", scheduledTerminalDepartures: ["21:15", "21:45", "22:15"] },
					{ lineId: "815", etaMinutes: "25", destination: "ΠΡΟΣ ΓΟΥΔΗ", routeCode: "9012", scheduledTerminalDepartures: ["21:45", "22:30"] }
				];
			} else if (activeIndex === 1) {
				data = [
					{ lineId: "040", etaMinutes: "2", destination: "ΠΕΙΡΑΙΑΣ - ΣΥΝΤΑΓΜΑ", routeCode: "111", scheduledTerminalDepartures: ["01:50", "02:20"] },
					{ lineId: "049", etaMinutes: "10", destination: "ΠΕΙΡΑΙΑΣ - ΟΜΟΝΟΙΑ", routeCode: "222", scheduledTerminalDepartures: ["02:00", "02:35"] }
				];
			} else {
				data = [
					{ lineId: "X95", etaMinutes: "15", destination: "ΣΥΝΤΑΓΜΑ - ΑΕΡΟΔΡΟΜΙΟ", routeCode: "333", scheduledTerminalDepartures: ["02:10", "02:50"] }
				];
			}
		} else {
			const filters = (settings.lineFilters || "").split(',').map(s => s.trim()).filter(s => s.length > 0);
			try {
				const activeIndex = this.activeStopIndex.get(actionObj.id) || 0;
				const currentStopCode = this.getActiveStopCode(settings, activeIndex) || settings.stopCode;
				
				if (!currentStopCode) {
					hasError = true;
					errorMessage = "Ορίστε κωδικό στάσης";
				} else {
					// 1. Get routes mapping for stop (cached)
					const { routes: routesMap, lines: stopLines } = await this.getStopRoutes(currentStopCode);

					// 2. Fetch live arrivals
					const res = await fetch(`https://telematics.oasa.gr/api/?act=getStopArrivals&p1=${currentStopCode}`, { signal: AbortSignal.timeout(25000) });
					
					if (!res.ok) {
						hasError = true;
						errorMessage = `HTTP Σφάλμα: ${res.status}`;
						const errText = await res.text().catch(() => 'N/A');
						streamDeck.logger.error(`API Error: HTTP ${res.status} for stop ${currentStopCode}. Body: ${errText}`);
						console.error(`API Error: HTTP ${res.status} for stop ${currentStopCode}. Body: ${errText}`);
					} else {
						const rawArrivalsText = await res.text();
						let rawArrivals = null;
						try {
							rawArrivals = JSON.parse(rawArrivalsText);
						} catch (e) {
							// Non-JSON or empty response
						}

						const arrivals = Array.isArray(rawArrivals) ? rawArrivals : [];
						const processedLineIds = new Set<string>();

						// Process live arrivals first
						for (const arr of arrivals) {
							const routeInfo = routesMap.get(arr.route_code);
							const lineId = routeInfo?.lineId || arr.line_id || "BUS";

							if (filters.length > 0 && !filters.includes(lineId)) continue;
							if (processedLineIds.has(lineId)) continue;
							processedLineIds.add(lineId);

							const liveEta = (arr.btime2 && arr.btime2.trim() !== "") ? arr.btime2.trim() : null;
							const dest = routeInfo?.routeDescr ? ("ΠΡΟΣ " + routeInfo.routeDescr) : ("ΠΡΟΣ " + (arr.dest_nme || "ΤΕΡΜΑ"));
							const lineCode = routeInfo?.lineCode || "";

							let terminalDepartures: string[] = [];
							if (lineCode) {
								terminalDepartures = await this.fetchSchedules(lineCode);
							}

							data.push({
								lineId,
								etaMinutes: liveEta,
								destination: dest,
								routeCode: arr.route_code,
								scheduledTerminalDepartures: terminalDepartures
							});
						}

						// If user filtered lines or if we have stop lines without live arrivals, add them as scheduled fallback
						const linesToAdd = filters.length > 0
							? stopLines.filter(l => filters.includes(l.lineId) && !processedLineIds.has(l.lineId))
							: stopLines.filter(l => !processedLineIds.has(l.lineId)).slice(0, Math.max(0, 6 - data.length));

						for (const sl of linesToAdd) {
							processedLineIds.add(sl.lineId);
							let terminalDepartures: string[] = [];
							if (sl.lineCode) {
								terminalDepartures = await this.fetchSchedules(sl.lineCode);
							}
							data.push({
								lineId: sl.lineId,
								etaMinutes: null,
								destination: "ΠΡΟΣ " + (sl.routeDescr || "ΤΕΡΜΑ"),
								routeCode: sl.routeCode,
								scheduledTerminalDepartures: terminalDepartures
							});
						}

						// Sort data: Live first, then Scheduled, then by time
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
				}
			} catch (err: any) {
				streamDeck.logger.error("API Error during fetchAndUpdate:", err);
				console.error("API Error during fetchAndUpdate:", err);
				hasError = true;
				if (err.name === 'TimeoutError' || err.name === 'AbortError') {
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
			this.stopLoadingAnimation(actionObj.id);

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

	private async getStopRoutes(stopCode: string): Promise<{ routes: Map<string, RouteInfo>; lines: StopLineInfo[] }> {
		const cached = this.stopRoutesCache.get(stopCode);
		if (cached && (Date.now() - cached.timestamp < 30 * 60 * 1000)) {
			return { routes: cached.routes, lines: cached.lines };
		}

		const routes = new Map<string, RouteInfo>();
		const lines: StopLineInfo[] = [];

		try {
			const res = await fetch(`https://telematics.oasa.gr/api/?act=webRoutesForStop&p1=${stopCode}`, { signal: AbortSignal.timeout(25000) });
			if (res.ok) {
				const data = await res.json() as any;
				if (Array.isArray(data)) {
					const seenLines = new Set<string>();
					for (const r of data) {
						if (!routes.has(r.RouteCode)) {
							routes.set(r.RouteCode, {
								lineId: r.LineID,
								lineCode: r.LineCode,
								routeDescr: r.RouteDescr,
								lineDescr: r.LineDescr
							});
						}
						if (!seenLines.has(r.LineID)) {
							seenLines.add(r.LineID);
							lines.push({
								lineId: r.LineID,
								lineCode: r.LineCode,
								routeDescr: r.RouteDescr,
								lineDescr: r.LineDescr,
								routeCode: r.RouteCode
							});
						}
					}
				}
			}
		} catch (err) {
			streamDeck.logger.warn("Failed to fetch stop routes:", err);
			console.warn("Failed to fetch stop routes:", err);
		}

		const result = { timestamp: Date.now(), routes, lines };
		this.stopRoutesCache.set(stopCode, result);
		return { routes, lines };
	}

	private async fetchSchedules(lineCode: string): Promise<string[]> {
		try {
			const res = await fetch(`https://telematics.oasa.gr/api/?act=getDailySchedule&line_code=${lineCode}`, { signal: AbortSignal.timeout(25000) });
			const sData = await res.json() as any;
			const deps = [...(sData?.come || []), ...(sData?.go || [])];
			const now = new Date();
			const curMins = now.getHours() * 60 + now.getMinutes();

			const times: { time: string; mins: number }[] = [];
			for (const item of deps) {
				const startStr = item.sde_start1 || item.sde_start2;
				if (startStr) {
					const timePart = startStr.split(' ')[1]?.slice(0, 5);
					if (timePart) {
						const [h, m] = timePart.split(':').map(Number);
						if ((h * 60 + m) > curMins) {
							times.push({ time: timePart, mins: h * 60 + m });
						}
					}
				}
			}
			times.sort((a, b) => a.mins - b.mins);
			return [...new Set(times.map(t => t.time))].slice(0, 2);
		} catch (e) {
			streamDeck.logger.warn("Failed to fetch schedules:", e);
			console.warn("Failed to fetch schedules:", e);
			return [];
		}
	}

	private generateLoadingSVG(rotation: number = 0, pulse: number = 0.6): string {
		const W = 144, H = 144;
		let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`;
		svg += `<rect width="${W}" height="${H}" fill="#000000" />`;

		// Outer subtle ring
		svg += `<circle cx="72" cy="66" r="28" fill="none" stroke="#111827" stroke-width="2" />`;
		// Animated arc spinner
		svg += `
			<circle cx="72" cy="66" r="28" fill="none" stroke="#00E5FF" stroke-width="2.5" stroke-dasharray="30 146" stroke-linecap="round" transform="rotate(${rotation} 72 66)">
			</circle>
		`;
		// Pulsing inner dot
		svg += `
			<circle cx="72" cy="66" r="3" fill="#00E5FF" opacity="${pulse}">
			</circle>
		`;
		// Label
		svg += `<text x="72" y="108" font-family="Inter,Roboto,sans-serif" font-size="8" font-weight="700" fill="#374151" text-anchor="middle" letter-spacing="2.5">LOADING</text>`;

		svg += `</svg>`;
		return svg;
	}

	private generateErrorSVG(errorMessage: string): string {
		const W = 144, H = 144;
		let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`;
		svg += `<rect width="${W}" height="${H}" fill="#000000" />`;

		// Error glow circle
		svg += `<circle cx="72" cy="54" r="28" fill="#450a0a" opacity="0.35" />`;
		// Warning icon — outlined triangle
		svg += `
			<path d="M72 32 L48 78 L96 78 Z" fill="none" stroke="#EF4444" stroke-width="2" stroke-linejoin="round" opacity="0.7" />
			<path d="M72 36 L52 74 L92 74 Z" fill="#0C0406" />
			<line x1="72" y1="50" x2="72" y2="63" stroke="#EF4444" stroke-width="3" stroke-linecap="round" />
			<circle cx="72" cy="69" r="2" fill="#EF4444" />
		`;

		// Error title
		svg += `<text x="72" y="96" font-family="Inter,Roboto,sans-serif" font-size="9" font-weight="800" fill="#EF4444" text-anchor="middle" letter-spacing="1">ΣΦΑΛΜΑ OASA</text>`;

		// Error details (word-wrapped)
		const words = errorMessage.split(' ');
		const half = Math.ceil(words.length / 2);
		const line1 = words.slice(0, half).join(' ');
		const line2 = words.slice(half).join(' ');
		if (line2.length > 0) {
			svg += `<text x="72" y="112" font-family="Inter,Roboto,sans-serif" font-size="7" font-weight="500" fill="#6B7280" text-anchor="middle">${line1}</text>`;
			svg += `<text x="72" y="122" font-family="Inter,Roboto,sans-serif" font-size="7" font-weight="500" fill="#6B7280" text-anchor="middle">${line2}</text>`;
		} else {
			svg += `<text x="72" y="112" font-family="Inter,Roboto,sans-serif" font-size="7" font-weight="500" fill="#6B7280" text-anchor="middle">${line1}</text>`;
		}

		// Pulsing retry hint
		svg += `
			<text x="72" y="137" font-family="Inter,Roboto,sans-serif" font-size="7" font-weight="600" fill="#374151" text-anchor="middle" letter-spacing="1">
				HOLD 5s TO RETRY
				<animate attributeName="opacity" values="1;0.3;1" dur="2.5s" repeatCount="indefinite" />
			</text>
		`;

		svg += `</svg>`;
		return svg;
	}

	private generateLedSVG(allLines: BusData[], page1: number, page2: number, offsetY: number, rawConfigs?: string, busColor1?: string, busColor2?: string, actionId?: string): string {
		const W = 144, H = 144;
		const panelHeight = 56;

		let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`;

		// ═══════════════════════════════════════════════════════
		// DEFS — Gradients, filters, and reusable elements
		// ═══════════════════════════════════════════════════════
		svg += `
		<defs>
			<linearGradient id="cardBg" x1="0%" y1="0%" x2="0%" y2="100%">
				<stop offset="0%" stop-color="#111827" />
				<stop offset="100%" stop-color="#0A0F18" />
			</linearGradient>
			<linearGradient id="schedBox" x1="0%" y1="0%" x2="0%" y2="100%">
				<stop offset="0%" stop-color="#0F1520" />
				<stop offset="100%" stop-color="#080D14" />
			</linearGradient>
			<linearGradient id="sepFade" x1="0%" y1="0%" x2="100%" y2="0%">
				<stop offset="0%" stop-color="#000000" />
				<stop offset="25%" stop-color="#1F2937" />
				<stop offset="75%" stop-color="#1F2937" />
				<stop offset="100%" stop-color="#000000" />
			</linearGradient>
		</defs>
		`;

		// Background — true OLED black with a hair of cold blue
		svg += `<rect width="${W}" height="${H}" fill="#000000" />`;

		// ═══════════════════════════════════════════════════════
		// EMPTY STATE
		// ═══════════════════════════════════════════════════════
		if (allLines.length === 0) {
			svg += `
				<text x="72" y="64" font-family="Inter,Roboto,sans-serif" font-size="12" font-weight="800" fill="#1F2937" text-anchor="middle" letter-spacing="3">NO DATA</text>
				<circle cx="72" cy="84" r="3" fill="none" stroke="#1F2937" stroke-width="1.5">
					<animate attributeName="r" values="3;7;3" dur="2s" repeatCount="indefinite" />
					<animate attributeName="opacity" values="0.8;0.1;0.8" dur="2s" repeatCount="indefinite" />
				</circle>
			`;
			svg += `</svg>`;
			return svg;
		}

		// ═══════════════════════════════════════════════════════
		// SETUP
		// ═══════════════════════════════════════════════════════
		let fetchTime = 0;
		if (actionId && this.lastFetchTime.has(actionId)) {
			fetchTime = this.lastFetchTime.get(actionId) || 0;
		}

		const getSafeSize = (text: string, maxW: number, defaultSize: number, w: number = 0.6): number => {
			const est = text.length * (defaultSize * w);
			return est > maxW ? Math.floor(defaultSize * (maxW / est)) : defaultSize;
		};

		const c1 = busColor1 || "#00E5FF";
		const c2 = busColor2 || "#FF6B00";

		// Parse line configs
		const configs = new Map<string, { color: string, text: string }>();
		if (rawConfigs) {
			for (const l of rawConfigs.split('\n')) {
				const p = l.split(',');
				if (p.length >= 3) configs.set(p[0].trim(), { color: p[1].trim(), text: p[2].trim() });
			}
		}

		// ═══════════════════════════════════════════════════════
		// SCROLLING GROUP
		// ═══════════════════════════════════════════════════════
		svg += `<g transform="translate(0, ${-offsetY})">`;

		// ───────────────────────────────────────────────────────
		// SLOT HELPERS
		// ───────────────────────────────────────────────────────
		const getSlotType = (pg: number, sl: number): 'bus' | 'credits' | 'empty' => {
			const idx = pg * 2 + sl;
			if (idx < allLines.length) return 'bus';
			if (idx === allLines.length) return 'credits';
			return 'empty';
		};

		const drawSeparator = (yPos: number) =>
			`<line x1="20" y1="${yPos}" x2="124" y2="${yPos}" stroke="url(#sepFade)" stroke-width="1" />`;

		// ───────────────────────────────────────────────────────
		// CREDITS BLOCK
		// ───────────────────────────────────────────────────────
		const drawCreditsBlock = (vi: number) => {
			const y = 8 + (vi * (panelHeight + 12));
			const mid = y + panelHeight / 2;
			let ts = "--:--";
			if (fetchTime > 0) {
				const d = new Date(fetchTime);
				ts = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
			}
			return `
				<rect x="8" y="${y + 2}" width="128" height="${panelHeight}" fill="#000" opacity="0.45" rx="10" />
				<rect x="8" y="${y}" width="128" height="${panelHeight}" fill="url(#cardBg)" rx="10" stroke="#1B2332" stroke-width="0.5" stroke-opacity="0.5" />
				<rect x="11" y="${y + 6}" width="3" height="${panelHeight - 12}" rx="1.5" fill="#6366F1" opacity="0.5" />
				<text x="72" y="${mid - 10}" font-family="Inter,Roboto,sans-serif" font-size="8" font-weight="500" fill="#484F58" text-anchor="middle" letter-spacing="1.5">MADE BY</text>
				<text x="72" y="${mid + 4}" font-family="Inter,Roboto,sans-serif" font-size="13" font-weight="900" fill="#F0F6FC" text-anchor="middle">miketsak.gr</text>
				<text x="72" y="${mid + 18}" font-family="Inter,Roboto,sans-serif" font-size="8" font-weight="400" fill="#374151" text-anchor="middle">${ts}</text>
			`;
		};

		// ───────────────────────────────────────────────────────
		// BUS BLOCK (the core visual)
		// ───────────────────────────────────────────────────────
		const drawBlock = (line: BusData, vi: number) => {
			const y = 8 + (vi * (panelHeight + 12));
			const mid = y + panelHeight / 2;

			const lc = configs.get(line.lineId);
			const accent = lc ? lc.color : ((vi % 2 === 0) ? c1 : c2);
			const label  = lc ? lc.text  : line.lineId;

			let s = '';

			// ▸ Card shell: shadow + background + thin border
			s += `<rect x="8" y="${y + 2}" width="128" height="${panelHeight}" fill="#000" opacity="0.45" rx="10" />`;
			s += `<rect x="8" y="${y}" width="128" height="${panelHeight}" fill="url(#cardBg)" rx="10" stroke="#1B2332" stroke-width="0.5" stroke-opacity="0.5" />`;

			// ▸ Accent bar — glowing vertical stripe on the left edge
			s += `<rect x="11" y="${y + 6}" width="3" height="${panelHeight - 12}" rx="1.5" fill="${accent}" opacity="0.9" />`;
			s += `<rect x="10" y="${y + 6}" width="5" height="${panelHeight - 12}" rx="2.5" fill="${accent}" opacity="0.12" />`;

			// ▸ Line ID badge
			const idSz = getSafeSize(label, 28, 12, 0.65);
			const badgeW = Math.max(28, label.length * idSz * 0.55 + 12);
			const badgeX = 18;
			s += `<rect x="${badgeX}" y="${mid - 10}" width="${badgeW}" height="20" fill="#080C14" rx="5" />`;
			s += `<text x="${badgeX + badgeW / 2}" y="${mid}" dominant-baseline="middle" font-family="Inter,Roboto,sans-serif" font-size="${idSz}" font-weight="900" fill="${accent}" text-anchor="middle">${label}</text>`;

			// ▸ Center — Main ETA display
			// etaX sits at the visual center between badge right edge (~50) and right box (94)
			const etaX = 74;
			let isScheduledFallback = false;

			if (line.etaMinutes !== null) {
				// ──── LIVE ETA ────
				const mins = parseInt(line.etaMinutes) || 0;
				const display = `${mins}`;
				const sz = getSafeSize(display, 38, mins >= 100 ? 20 : (mins >= 10 ? 26 : 30), 0.65);

				// Glow halo behind the number (accent-tinted)
				s += `<circle cx="${etaX}" cy="${mid - 2}" r="16" fill="${accent}" opacity="0.06" />`;
				// Stroke glow
				s += `<text x="${etaX}" y="${mid - 3}" dominant-baseline="middle" font-family="Inter,Roboto,sans-serif" font-size="${sz}" font-weight="900" fill="${accent}" opacity="0.15" text-anchor="middle" stroke="${accent}" stroke-width="4">${display}</text>`;
				// Main number
				s += `<text x="${etaX}" y="${mid - 3}" dominant-baseline="middle" font-family="Inter,Roboto,sans-serif" font-size="${sz}" font-weight="900" fill="#F0F6FC" text-anchor="middle">${display}</text>`;
				// "MIN" sublabel
				s += `<text x="${etaX}" y="${mid + 12}" dominant-baseline="middle" font-family="Inter,Roboto,sans-serif" font-size="7" font-weight="700" fill="#484F58" text-anchor="middle" letter-spacing="1.5">MIN</text>`;

				// ▸ Proximity progress bar
				const barY = y + panelHeight - 5;
				const barX = 18;
				const barMaxW = 66;
				const pct = Math.max(0.08, Math.min(1, 1 - (mins / 40)));
				const barW = Math.round(barMaxW * pct);
				// Track
				s += `<rect x="${barX}" y="${barY}" width="${barMaxW}" height="2" rx="1" fill="#111827" />`;
				// Fill
				s += `<rect x="${barX}" y="${barY}" width="${barW}" height="2" rx="1" fill="${accent}" opacity="0.55" />`;
				// Bright tip
				if (barW > 3) {
					s += `<rect x="${barX + barW - 3}" y="${barY}" width="3" height="2" rx="1" fill="${accent}" />`;
				}
			} else {
				// ──── SCHEDULED FALLBACK ────
				isScheduledFallback = true;
				const schedDisplay = line.scheduledTerminalDepartures[0] || "--:--";
				const sz = getSafeSize(schedDisplay, 40, 16, 0.65);

				s += `<text x="${etaX}" y="${mid - 5}" dominant-baseline="middle" font-family="Inter,Roboto,sans-serif" font-size="${sz}" font-weight="800" fill="#8B949E" text-anchor="middle">${schedDisplay}</text>`;
				s += `<text x="${etaX}" y="${mid + 9}" dominant-baseline="middle" font-family="Inter,Roboto,sans-serif" font-size="7" font-weight="700" fill="#374151" text-anchor="middle" letter-spacing="2">SCHED</text>`;
			}

			// ▸ Right column — upcoming scheduled departures
			let t1: string, t2: string;
			if (isScheduledFallback) {
				t1 = line.scheduledTerminalDepartures[1] || "";
				t2 = line.scheduledTerminalDepartures[2] || "";
			} else {
				t1 = line.scheduledTerminalDepartures[0] || "";
				t2 = line.scheduledTerminalDepartures[1] || "";
			}

			const rBoxX = 94, rBoxW = 38;
			const rAnchor = rBoxX + rBoxW - 5;

			// Right column box (always drawn for visual consistency)
			s += `<rect x="${rBoxX}" y="${y + 8}" width="${rBoxW}" height="${panelHeight - 16}" rx="5" fill="url(#schedBox)" stroke="#1B2332" stroke-width="0.5" stroke-opacity="0.3" />`;

			if (t1 && t2) {
				s += `<text x="${rAnchor}" y="${mid - 6}" dominant-baseline="middle" font-family="Inter,Roboto,sans-serif" font-size="9" font-weight="600" fill="#8B949E" text-anchor="end">${t1}</text>`;
				s += `<text x="${rAnchor}" y="${mid + 7}" dominant-baseline="middle" font-family="Inter,Roboto,sans-serif" font-size="9" font-weight="400" fill="#484F58" text-anchor="end">${t2}</text>`;
			} else if (t1) {
				s += `<text x="${rAnchor}" y="${mid}" dominant-baseline="middle" font-family="Inter,Roboto,sans-serif" font-size="9" font-weight="600" fill="#8B949E" text-anchor="end">${t1}</text>`;
			} else {
				// Empty — subtle dot
				s += `<circle cx="${rBoxX + rBoxW / 2}" cy="${mid}" r="1.5" fill="#1F2937" />`;
			}

			return s;
		};

		// ═══════════════════════════════════════════════════════
		// RENDER PAGES
		// ═══════════════════════════════════════════════════════
		for (let slot = 0; slot < 2; slot++) {
			const type = getSlotType(page1, slot);
			if (type === 'bus') svg += drawBlock(allLines[page1 * 2 + slot], slot);
			else if (type === 'credits') svg += drawCreditsBlock(slot);
		}
		if (getSlotType(page1, 1) !== 'empty') {
			svg += drawSeparator(71);
		}

		if (page1 !== page2) {
			for (let slot = 0; slot < 2; slot++) {
				const type = getSlotType(page2, slot);
				if (type === 'bus') svg += drawBlock(allLines[page2 * 2 + slot], slot + 2);
				else if (type === 'credits') svg += drawCreditsBlock(slot + 2);
			}
			if (getSlotType(page2, 1) !== 'empty') {
				svg += drawSeparator(71 + 144);
			}
		}

		svg += `</g>`; // end scroll group

		// ═══════════════════════════════════════════════════════
		// FIXED BOTTOM BAR — Status + Pagination (outside scroll)
		// ═══════════════════════════════════════════════════════
		if (fetchTime > 0) {
			const isFresh = (Date.now() - fetchTime) < 110000;
			const sColor = isFresh ? '#3FB950' : '#D29922';
			const sLabel = isFresh ? 'LIVE' : 'STALE';
			const d = new Date(fetchTime);
			const ts = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;

			svg += `
				<text x="8" y="139" font-family="Inter,Roboto,sans-serif" font-size="8" font-weight="600" fill="#374151" text-anchor="start">
					<tspan fill="${sColor}">●</tspan> <tspan fill="${sColor}">${sLabel}</tspan> ${ts}
				</text>
			`;
		}

		// Pagination dots
		const maxPages = Math.ceil((allLines.length + 1) / 2);
		const activePage = (offsetY >= 72) ? page2 : page1;

		if (maxPages > 1) {
			const dotsY = 139;
			const dotSpacing = 10;
			const dotsWidth = (maxPages - 1) * dotSpacing;
			const startX = W - 8 - dotsWidth;

			for (let p = 0; p < maxPages; p++) {
				const active = p === activePage;
				const dx = startX + (p * dotSpacing);
				if (active) {
					// Active dot: accent-colored pill
					svg += `<rect x="${dx - 5}" y="${dotsY - 2.5}" width="10" height="5" rx="2.5" fill="#00AAFF" />`;
				} else {
					svg += `<circle cx="${dx}" cy="${dotsY}" r="2" fill="#1F2937" />`;
				}
			}
		}

		svg += `</svg>`;
		return svg;
	}
}
