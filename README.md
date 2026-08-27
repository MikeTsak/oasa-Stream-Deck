# OASA Bus Stream Deck Plugin

A custom Elgato Stream Deck plugin that provides real-time bus arrivals for the Athens public transit network (OASA). Built with the official Node.js SDK and TypeScript, featuring a dynamic "Material You" design interface on the Stream Deck buttons.

## Features
- **Real-Time Arrivals:** Displays live ETA for buses at a specific stop.
- **Dynamic Material You UI:** Custom SVG rendering directly on the Stream Deck button.
- **Pagination:** If more than two buses are arriving, **Short Press** the button to scroll through the list.
- **Manual Refresh:** **Long Press** the button to force an immediate API refresh.
- **Custom Styling:** Define specific colors and emojis/text per bus line through the Property Inspector.
- **Debug Mode:** A "Dummy Content" toggle is available to test custom styles without waiting for real buses.

## Installation & Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Build and run in watch mode:
   ```bash
   npm run watch
   ```
   This will compile the TypeScript code into the `com.miketsakgr.oasa-bus.sdPlugin` folder and reload the Stream Deck software.

3. Drag the "Bus Arrival" action from your Stream Deck application onto a button.

## Configuration

In the Stream Deck Property Inspector for this button, you can configure:

- **Stop Code:** The 6-digit OASA stop code (e.g., `070106`).
- **Line Filters:** A comma-separated list of lines you want to track (e.g., `856, 815`).
- **Line Overrides:** Customize the visual appearance of specific lines. Format is `Line,Color,Text` (one per line). 
  Example:
  ```
  856,#e34234,ΕΞΠΡΕΣ
  815,#2c9e4b,🚌
  ```
- **Dummy content:** Check this box to populate the button with fake data, useful for testing your Line Overrides.

## Technologies Used
- [@elgato/streamdeck](https://www.npmjs.com/package/@elgato/streamdeck)
- TypeScript
- Dynamic SVG Generation
- OASA Telematics API

## License
MIT License
