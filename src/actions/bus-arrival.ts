import { action, DidReceiveSettingsEvent, SingletonAction, WillAppearEvent, WillDisappearEvent, KeyAction, DialAction } from "@elgato/streamdeck";

type BusSettings = {
	stopCode?: string;
};

@action({ UUID: "com.miketsakgr.oasa-bus.arrival" })
export class BusArrival extends SingletonAction<BusSettings> {
	private intervals: Map<string, NodeJS.Timeout> = new Map();

	override async onWillAppear(ev: WillAppearEvent<BusSettings>): Promise<void> {
		const stopCode = ev.payload.settings.stopCode;
		if (stopCode) {
			await this.fetchAndUpdate(ev.action, stopCode);
			this.startPolling(ev.action.id, ev.action, stopCode);
		} else {
			if (ev.action.isKey()) {
				await ev.action.setTitle("Set\nStop");
			}
		}
	}

	override onWillDisappear(ev: WillDisappearEvent<BusSettings>): void | Promise<void> {
		this.stopPolling(ev.action.id);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<BusSettings>): Promise<void> {
		this.stopPolling(ev.action.id);
		const stopCode = ev.payload.settings.stopCode;
		if (stopCode) {
			await this.fetchAndUpdate(ev.action, stopCode);
			this.startPolling(ev.action.id, ev.action, stopCode);
		} else {
			if (ev.action.isKey()) {
				await ev.action.setTitle("Set\nStop");
			}
		}
	}

	private startPolling(actionId: string, actionObj: KeyAction<BusSettings> | DialAction<BusSettings>, stopCode: string) {
		const interval = setInterval(() => {
			this.fetchAndUpdate(actionObj, stopCode);
		}, 60000);
		this.intervals.set(actionId, interval);
	}

	private stopPolling(actionId: string) {
		const interval = this.intervals.get(actionId);
		if (interval) {
			clearInterval(interval);
			this.intervals.delete(actionId);
		}
	}

	private async fetchAndUpdate(actionObj: KeyAction<BusSettings> | DialAction<BusSettings>, stopCode: string) {
		try {
			const res = await fetch(`http://telematics.oasa.gr/api/?act=getStopArrivals&p1=${stopCode}`);
			const data = await res.json();
			
			if (actionObj.isKey()) {
				if (Array.isArray(data) && data.length > 0) {
					const btime2 = data[0].btime2;
					await actionObj.setTitle(`${btime2}\nΛεπτά`);
				} else {
					await actionObj.setTitle("N/A");
				}
			}
		} catch (err) {
			console.error("Failed to fetch bus arrivals:", err);
			if (actionObj.isKey()) {
				await actionObj.setTitle("Err");
			}
		}
	}
}
