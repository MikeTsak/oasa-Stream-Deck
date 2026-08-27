import streamDeck, { action, DidReceiveSettingsEvent, SingletonAction, WillAppearEvent, WillDisappearEvent, KeyAction, DialAction, KeyDownEvent, KeyUpEvent } from "@elgato/streamdeck";
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

type BusSettings = {
	stopCode?: string;
	lineFilters?: string;
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

	override async onWillAppear(ev: WillAppearEvent<BusSettings>): Promise<void> {
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

	override onWillDisappear(ev: WillDisappearEvent<BusSettings>): void | Promise<void> {
		this.stopPolling(ev.action.id);
		this.keyDownTimes.delete(ev.action.id);
		this.lastData.delete(ev.action.id);
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
				// Long press: open local website
				await this.generateAndOpenDashboard(settings, ev.action.id);
			} else {
				// Short press: manual refresh
				if (ev.action.isKey()) {
					// Visual feedback clear title during loading
					await ev.action.setTitle("");
				}
				await this.fetchAndUpdate(ev.action, settings);
				
				this.stopPolling(ev.action.id);
				this.startPolling(ev.action.id, ev.action, settings);
			}
		}
	}

	private startPolling(actionId: string, actionObj: KeyAction<BusSettings> | DialAction<BusSettings>, settings: BusSettings) {
		const interval = setInterval(() => {
			this.fetchAndUpdate(actionObj, settings);
		}, 180000);
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

		const filters = (settings.lineFilters || "").split(',').map(s => s.trim()).filter(s => s.length > 0);
		
		let data: BusData[] = [];
		try {
			// 1. Fetch live arrivals
			const res = await fetch(`http://telematics.oasa.gr/api/?act=getStopArrivals&p1=${settings.stopCode}`);
			const rawArrivals = (await res.json()) as any[];

			if (Array.isArray(rawArrivals) && rawArrivals.length > 0) {
				// 2. Filter lines
				let selected = rawArrivals;
				if (filters.length > 0) {
					selected = rawArrivals.filter(arr => filters.includes(arr.line_id));
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

				// We can only show 2 lines on the button
				const linesToShow = uniqueLines.slice(0, 2);

				// 3. For each line, fetch scheduled data (with mock fallback if API fails)
				for (const arrival of linesToShow) {
					let terminalDepartures = ["N/A", "N/A"];
					let arrivalAtStop = "N/A";
					
					try {
						// Attempt to get schedule details. 
						const schedRes = await fetch(`http://telematics.oasa.gr/api/?act=getDailySchedule&line_code=${arrival.route_code}`, { signal: AbortSignal.timeout(3000) });
						const schedule = await schedRes.json();
						
						if (Array.isArray(schedule) && schedule.length > 0) {
							// Find next departures based on current time
							const now = new Date();
							const currentMinutes = now.getHours() * 60 + now.getMinutes();
							
							const futureDeps = schedule.filter(s => {
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

							// Estimate arrival time at stop based on live ETA
							const etaMins = parseInt(arrival.btime2) || 0;
							const arrivalTime = new Date(now.getTime() + etaMins * 60000);
							arrivalAtStop = `${arrivalTime.getHours().toString().padStart(2, '0')}:${arrivalTime.getMinutes().toString().padStart(2, '0')}`;
						}
					} catch (e) {
						console.log("Schedule API failed/timeout, mocking schedule data");
						const now = new Date();
						const etaMins = parseInt(arrival.btime2) || 0;
						const arrivalTime = new Date(now.getTime() + etaMins * 60000);
						arrivalAtStop = `${arrivalTime.getHours().toString().padStart(2, '0')}:${arrivalTime.getMinutes().toString().padStart(2, '0')}`;
						
						const dep1 = new Date(now.getTime() + 15 * 60000);
						const dep2 = new Date(now.getTime() + 35 * 60000);
						terminalDepartures = [
							`${dep1.getHours().toString().padStart(2, '0')}:${dep1.getMinutes().toString().padStart(2, '0')}`,
							`${dep2.getHours().toString().padStart(2, '0')}:${dep2.getMinutes().toString().padStart(2, '0')}`
						];
					}

					data.push({
						lineId: arrival.line_id,
						etaMinutes: arrival.btime2,
						destination: "ΠΡΟΣ: " + (arrival.dest_nme || "ΤΕΡΜΑ").substring(0, 15),
						routeCode: arrival.route_code,
						scheduledTerminalDepartures: terminalDepartures,
						scheduledArrivalAtStop: arrivalAtStop
					});
				}
			}
		} catch (err) {
			console.error("API Error, using full mock", err);
			// Full mock data for dev when API is completely down
			const now = new Date();
			data = [
				{
					lineId: filters[0] || "856",
					etaMinutes: "5",
					destination: "ΠΡΟΣ ΑΙΓΑΛΕΩ",
					routeCode: "1234",
					scheduledTerminalDepartures: ["21:10", "21:30"],
					scheduledArrivalAtStop: "21:03"
				},
				{
					lineId: filters[1] || "A15",
					etaMinutes: "12",
					destination: "ΠΡΟΣ ΣΤΑΘ.ΛΑΡΙΣΗΣ",
					routeCode: "5678",
					scheduledTerminalDepartures: ["21:15", "21:45"],
					scheduledArrivalAtStop: "21:10"
				}
			];
		}
		
		this.lastData.set(actionObj.id, data);
		
		if (actionObj.isKey()) {
			await actionObj.setTitle(""); 
			const svg = this.generateCyberPanelSVG(data);
			await actionObj.setImage(`data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`);
		}
	}

	private generateLoadingSVG(): string {
		const width = 144;
		const height = 144;
		
		let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`;
		
		// 1. Background
		svg += `
			<defs>
				<pattern id="hex" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="scale(1)">
					<path d="M 6 0 L 12 3 L 12 9 L 6 12 L 0 9 L 0 3 Z" fill="none" stroke="#112211" stroke-width="0.5"/>
				</pattern>
				<linearGradient id="bgLoad" x1="0%" y1="0%" x2="0%" y2="100%">
					<stop offset="0%" stop-color="#0a150a" />
					<stop offset="100%" stop-color="#050a05" />
				</linearGradient>
			</defs>
			<rect width="100%" height="100%" fill="url(#bgLoad)" />
			<rect width="100%" height="100%" fill="url(#hex)" />
		`;

		// 2. HUD Elements
		const cx = 72;
		const cy = 56;
		const r1 = 30;
		const r2 = 24;
		const r3 = 18;
		
		svg += `
			<!-- Outer Dashed Ring -->
			<circle cx="${cx}" cy="${cy}" r="${r1}" fill="none" stroke="#004400" stroke-width="2" stroke-dasharray="4 6" />
			
			<!-- Middle Thick Ring -->
			<circle cx="${cx}" cy="${cy}" r="${r2}" fill="none" stroke="#00aa00" stroke-width="4" stroke-dasharray="40 110" stroke-dashoffset="10" transform="rotate(45 ${cx} ${cy})" />
			<circle cx="${cx}" cy="${cy}" r="${r2}" fill="none" stroke="#00ff00" stroke-width="4" stroke-dasharray="40 110" stroke-dashoffset="85" transform="rotate(45 ${cx} ${cy})" />
			
			<!-- Inner Core Ring -->
			<circle cx="${cx}" cy="${cy}" r="${r3}" fill="none" stroke="#00ff00" stroke-width="1" />
			
			<!-- Center Core -->
			<circle cx="${cx}" cy="${cy}" r="4" fill="#00ff00" />
			
			<!-- Crosshairs -->
			<line x1="${cx - 36}" y1="${cy}" x2="${cx - 20}" y2="${cy}" stroke="#00ff00" stroke-width="1" />
			<line x1="${cx + 20}" y1="${cy}" x2="${cx + 36}" y2="${cy}" stroke="#00ff00" stroke-width="1" />
			<line x1="${cx}" y1="${cy - 36}" x2="${cx}" y2="${cy - 20}" stroke="#00ff00" stroke-width="1" />
			<line x1="${cx}" y1="${cy + 20}" x2="${cx}" y2="${cy + 36}" stroke="#00ff00" stroke-width="1" />

			<!-- Corner Brackets -->
			<path d="M 10 20 L 10 10 L 20 10" fill="none" stroke="#00ff00" stroke-width="2" />
			<path d="M 134 20 L 134 10 L 124 10" fill="none" stroke="#00ff00" stroke-width="2" />
			<path d="M 10 124 L 10 134 L 20 134" fill="none" stroke="#00ff00" stroke-width="2" />
			<path d="M 134 124 L 134 134 L 124 134" fill="none" stroke="#00ff00" stroke-width="2" />
		`;
		
		// 3. Text
		svg += `
			<rect x="0" y="100" width="144" height="24" fill="#002200" opacity="0.8" />
			<rect x="0" y="100" width="144" height="1" fill="#00ff00" />
			<rect x="0" y="123" width="144" height="1" fill="#00ff00" />
			
			<text x="72" y="112" font-family="sans-serif" font-size="9" font-weight="bold" fill="#00ff00" text-anchor="middle" letter-spacing="0.5">LINKING TO OASA...</text>
			<text x="72" y="120" font-family="sans-serif" font-size="6" fill="#00aa00" text-anchor="middle" letter-spacing="2">ACQUIRING SIGNAL</text>
		</svg>`;
		
		return svg;
	}

	private generateCyberPanelSVG(lines: BusData[]): string {
		const width = 144;
		const height = 144;
		
		let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`;
		
		// 1. Background - Deep Grey Grid
		svg += `
			<defs>
				<pattern id="grid" width="8" height="8" patternUnits="userSpaceOnUse">
					<path d="M 8 0 L 0 0 0 8" fill="none" stroke="#222" stroke-width="0.5"/>
				</pattern>
				<linearGradient id="bg" x1="0%" y1="0%" x2="0%" y2="100%">
					<stop offset="0%" stop-color="#1a1a1f" />
					<stop offset="100%" stop-color="#0d0d12" />
				</linearGradient>
			</defs>
			<rect width="100%" height="100%" fill="url(#bg)" />
			<rect width="100%" height="100%" fill="url(#grid)" />
		`;

		// 2. Header Area
		svg += `
			<rect x="0" y="0" width="144" height="20" fill="#002200" />
			<rect x="0" y="18" width="144" height="2" fill="#00ff00" />
			<text x="72" y="14" font-family="sans-serif" font-size="10" font-weight="bold" fill="#00ff00" text-anchor="middle" letter-spacing="1">ΕΙΔΟΠΟΙΗΣΗ | ΓΕΦΥΡΑΚΙ</text>
		`;

		if (lines.length === 0) {
			svg += `<text x="72" y="80" font-family="sans-serif" font-size="14" font-weight="bold" fill="#ff4444" text-anchor="middle">NO DATA</text>`;
			svg += `</svg>`;
			return svg;
		}

		// 3. Draw Panels
		const panelHeight = 60;
		const startY = 22;
		
		for (let i = 0; i < Math.min(2, lines.length); i++) {
			const line = lines[i];
			const y = startY + (i * (panelHeight + 2));
			
			// Panel BG
			svg += `<rect x="2" y="${y}" width="140" height="${panelHeight}" fill="#111116" stroke="#2a2a35" stroke-width="1" rx="4" />`;
			
			// --- Left Column (Line ID) ---
			svg += `
				<rect x="6" y="${y + 6}" width="32" height="32" fill="#051505" stroke="#00ff00" stroke-width="1.5" rx="6" />
				<text x="22" y="${y + 28}" font-family="sans-serif" font-size="16" font-weight="900" fill="#00ff00" text-anchor="middle">${line.lineId}</text>
			`;

			// --- Center Column (Live ETA Gauge) ---
			const cx = 58;
			const cy = y + 22;
			const r = 16;
			const circumference = 2 * Math.PI * r;
			
			const eta = parseInt(line.etaMinutes) || 0;
			const fillPercentage = Math.max(0, Math.min(1, 1 - (eta / 45))); 
			const offset = circumference - (fillPercentage * circumference);

			svg += `
				<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#222" stroke-width="3" />
				<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#00ffff" stroke-width="3" 
					stroke-dasharray="${circumference}" stroke-dashoffset="${offset}" 
					transform="rotate(-90 ${cx} ${cy})" />
				<text x="${cx}" y="${cy + 5}" font-family="sans-serif" font-size="14" font-weight="bold" fill="#ffffff" text-anchor="middle">${line.etaMinutes}'</text>
				<text x="${cx}" y="${cy + 18}" font-family="sans-serif" font-size="6" font-weight="bold" fill="#00ffff" text-anchor="middle">ΛΕΠΤΑ</text>
			`;

			// --- Right Column (Scheduled Data) ---
			const rightX = 82;
			svg += `
				<text x="${rightX}" y="${y + 10}" font-family="sans-serif" font-size="6" fill="#888">ΣΧΕΔΙΑΣΜΕΝΕΣ ΕΞΟΔΟΙ ΑΦΕΤ.</text>
				<text x="${rightX}" y="${y + 19}" font-family="sans-serif" font-size="10" font-weight="bold" fill="#ffd700">${line.scheduledTerminalDepartures.join(", ")}</text>
				
				<text x="${rightX}" y="${y + 29}" font-family="sans-serif" font-size="6" fill="#888">ΕΠΟΜΕΝΗ ΚΙΝΗΣΗ</text>
				<text x="${rightX}" y="${y + 38}" font-family="sans-serif" font-size="10" font-weight="bold" fill="#ffaa00">${line.scheduledArrivalAtStop}</text>
			`;

			// --- Footer (Destination) ---
			svg += `
				<rect x="2" y="${y + 48}" width="140" height="12" fill="#222" rx="0" />
				<text x="72" y="${y + 57}" font-family="sans-serif" font-size="8" font-weight="bold" fill="#aaa" text-anchor="middle" letter-spacing="0.5">${line.destination}</text>
			`;
		}

		svg += `</svg>`;
		return svg;
	}

	private async generateAndOpenDashboard(settings: BusSettings, actionId: string) {
		const data = this.lastData.get(actionId) || [];
		
		let rowsHtml = "";
		if (data.length === 0) {
			rowsHtml = "<tr><td colspan='3' style='text-align:center;'>No arrivals currently available.</td></tr>";
		} else {
			for (const bus of data) {
				rowsHtml += `<tr><td>${bus.lineId}</td><td>${bus.destination}</td><td>${bus.etaMinutes} min</td></tr>`;
			}
		}

		const html = `
<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Stop ${settings.stopCode} Arrivals</title>
	<style>
		body { background-color: #121212; color: #ffffff; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 20px; }
		h1 { text-align: center; color: #00ff00; }
		table { width: 100%; max-width: 600px; margin: 0 auto; border-collapse: collapse; background: #1e1e1e; border-radius: 8px; overflow: hidden; }
		th, td { padding: 15px; text-align: left; border-bottom: 1px solid #333; }
		th { background-color: #2c2c2c; font-weight: bold; color: #00ff00; }
		tr:hover { background-color: #2a2a2a; }
		td:last-child { font-weight: bold; color: #00ffff; }
	</style>
</head>
<body>
	<h1>Bus Arrivals (Stop ${settings.stopCode})</h1>
	<table>
		<thead>
			<tr>
				<th>Bus Line</th>
				<th>Destination</th>
				<th>ETA</th>
			</tr>
		</thead>
		<tbody>
			${rowsHtml}
		</tbody>
	</table>
</body>
</html>`;
		try {
			const tmpPath = path.join(os.tmpdir(), `oasa-dashboard-${settings.stopCode}.html`);
			await fs.writeFile(tmpPath, html, 'utf-8');
			await streamDeck.system.openUrl(`file:///${tmpPath.replace(/\\/g, '/')}`);
		} catch (err) {
			console.error("Failed to generate dashboard:", err);
		}
	}
}
