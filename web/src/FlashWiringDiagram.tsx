export default function FlashWiringDiagram() {
  return <div className="flash-wiring-diagram">
    <img src="/flash-wiring.svg" alt="RAPT Pill to ESP32 bridge wiring: leave Pill 3V3 unconnected; connect EN to GPIO25, IO0 to GPIO26, E_RXD to GPIO17 TX, E_TXD to GPIO16 RX, and GND to GND." />
  </div>;
}
