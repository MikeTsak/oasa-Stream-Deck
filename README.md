# OASA Bus Arrivals - Stream Deck Plugin 🚌

A powerful and highly customizable Stream Deck plugin for tracking live bus arrivals in Athens (OASA Telematics). Get real-time updates directly on your Stream Deck buttons, complete with beautiful SVG rendering, multi-stop support, and color-coded lines.

## Features

- 🕒 **Live ETAs**: Real-time arrival estimates straight from OASA.
- 📅 **Scheduled Fallback**: If a live ETA isn't available, the plugin automatically fetches and displays the upcoming scheduled terminal departures.
- 🎨 **Visual Customization**: Dynamically overrides colors and labels for specific bus lines (e.g., color-code express lines).
- 🔄 **Multiple Stops**: Configure up to 5 different stops on a single button.
- 📱 **Smooth Pagination**: Automatically paginates if more than 2 buses are arriving. Just press the button to smoothly scroll to the next page!
- ⏳ **Loading Animations**: Displays a custom animated spinning loader directly on the key while fetching data from the API.
- ⚡ **Instant Refresh**: Hold the button for 5 seconds to force a hard refresh from the API, complete with a visual countdown overlay.
- 🔧 **Dummy Mode**: A built-in testing toggle to configure colors and UI without waiting for actual bus data.

## Installation

1. Download the `.streamDeckPlugin` file from the [Releases](https://github.com/MikeTsak/oasa-Stream-Deck/releases).
2. Double-click the file to install it into your Elgato Stream Deck software.
3. Drag and drop the "OASA Bus" action onto your canvas.

## Configuration & Usage

Once added to your Stream Deck, you can configure it via the Property Inspector:

### 1. Stop Codes
- **Primary Stop Code**: Find your stop code from the OASA Telematics website (e.g., `070106`).
- **Secondary Stops**: Add up to 4 additional stop codes. **Double-tap** the Stream Deck button to quickly cycle between them!

### 2. Line Filters
Only care about specific buses? Enter a comma-separated list of line IDs (e.g., `856, 815`) to prioritize them.

### 3. Line Overrides
Completely customize how lines look on your button using the `LineID,Color,CustomText` format. Add one per line in the text area:
```csv
856,#e34234,ΕΞΠΡΕΣ
815,#2c9e4b,🚌
049,#004A77,PIRAEUS
```

### Controls Summary
- **Short Press**: Smoothly scrolls to the next page of buses (if more than 2 are arriving).
- **Double Tap**: Cycles to the next configured secondary stop.
- **Long Press (Hold for 5s)**: Triggers an expanding circle animation and forces an immediate API refresh.

## Development

Built with TypeScript and standard SVG generation. No heavy native dependencies required.

```bash
# Install dependencies
npm install

# Build for development (watch mode)
npm run watch

# Build for production
npm run build

# Pack into a .streamDeckPlugin file
npm run pack
```

---
*Made with ❤️ by MikeTsak*
