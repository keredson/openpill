const encoder = new TextEncoder();

function bytes(view: DataView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
}

function nonce(base: Uint8Array, sequence: Uint8Array): Uint8Array {
  const iv = base.slice();
  for (let index = 0; index < 4; index++) iv[8 + index] ^= sequence[index];
  return iv;
}

export class SecureConfigChannel {
  private clientKey!: CryptoKey;
  private serverKey!: CryptoKey;
  private clientIv!: Uint8Array;
  private serverIv!: Uint8Array;
  private clientSequence = 0;
  private serverSequence = 0;

  constructor(
    private readonly session: BluetoothRemoteGATTCharacteristic,
    private readonly request: BluetoothRemoteGATTCharacteristic,
    private readonly response: BluetoothRemoteGATTCharacteristic,
    private readonly gatt: <T>(operation: () => Promise<T>) => Promise<T>,
  ) {}

  async open(): Promise<void> {
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const clientPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    if (clientPublic.length !== 65) throw new Error("Unexpected browser ECDH key size.");
    for (let offset = 0; offset < 65; offset += 19) {
      const fragment = new Uint8Array(1 + Math.min(19, 65 - offset));
      fragment[0] = offset;
      fragment.set(clientPublic.subarray(offset, offset + 19), 1);
      await this.gatt(() => this.session.writeValueWithResponse(fragment));
    }
    const deadline = Date.now() + 20_000;
    let answer: Uint8Array;
    do {
      answer = bytes(await this.gatt(() => this.session.readValue()));
      if (answer.length !== 66 || answer[0] > 1) throw new Error("Unsupported Pill secure configuration protocol.");
      if (answer[0] === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    if (answer[0] !== 1) throw new Error("The Pill did not finish opening its secure configuration session.");
    const serverPublic = answer.subarray(1);
    const peer = await crypto.subtle.importKey("raw", Uint8Array.from(serverPublic).buffer, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, pair.privateKey, 256);
    const transcript = new Uint8Array(130);
    transcript.set(clientPublic);
    transcript.set(serverPublic, 65);
    const salt = await crypto.subtle.digest("SHA-256", transcript);
    const hkdf = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
    const material = new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt,
      info: encoder.encode("OpenPill config v1").buffer }, hkdf, 88 * 8));
    this.clientKey = await crypto.subtle.importKey("raw", material.slice(0, 32), "AES-GCM", false, ["encrypt"]);
    this.clientIv = material.slice(32, 44);
    this.serverKey = await crypto.subtle.importKey("raw", material.slice(44, 76), "AES-GCM", false, ["decrypt"]);
    this.serverIv = material.slice(76, 88);
    material.fill(0);
  }

  async send(opcode: number, payload: Uint8Array = new Uint8Array()): Promise<Uint8Array> {
    const plain = new Uint8Array(payload.length + 1);
    plain[0] = opcode;
    plain.set(payload, 1);
    const sequence = new Uint8Array(4);
    new DataView(sequence.buffer).setUint32(0, ++this.clientSequence, true);
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: Uint8Array.from(nonce(this.clientIv, sequence)).buffer,
      additionalData: sequence.buffer }, this.clientKey, plain.buffer));
    const packet = new Uint8Array(4 + encrypted.length);
    packet.set(sequence);
    packet.set(encrypted, 4);
    if (packet.length > 255) throw new Error("Secure request is too large.");
    for (let offset = 0; offset < packet.length; offset += 18) {
      const fragment = new Uint8Array(2 + Math.min(18, packet.length - offset));
      fragment[0] = packet.length;
      fragment[1] = offset;
      fragment.set(packet.subarray(offset, offset + 18), 2);
      await this.gatt(() => this.request.writeValueWithResponse(fragment));
    }
    const answer = bytes(await this.gatt(() => this.response.readValue()));
    if (answer.length < 20) throw new Error("The Pill returned an incomplete secure response.");
    const replySequence = answer.subarray(0, 4);
    if (new DataView(answer.buffer).getUint32(0, true) !== this.serverSequence + 1) {
      throw new Error("The Pill returned an out-of-order secure response.");
    }
    const opened = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Uint8Array.from(nonce(this.serverIv, replySequence)).buffer,
      additionalData: Uint8Array.from(replySequence).buffer }, this.serverKey, Uint8Array.from(answer.subarray(4)).buffer);
    this.serverSequence++;
    return new Uint8Array(opened);
  }

  async readText(opcode: number): Promise<string> {
    let result = new Uint8Array();
    let expected = 0;
    do {
      const offset = new Uint8Array(2);
      new DataView(offset.buffer).setUint16(0, result.length, true);
      const page = await this.send(opcode, offset);
      if (page.length < 2) throw new Error("Incomplete secure configuration page.");
      const total = new DataView(page.buffer).getUint16(0, true);
      if (result.length && total !== expected) throw new Error("Configuration changed during read.");
      expected = total;
      const next = new Uint8Array(result.length + page.length - 2);
      next.set(result);
      next.set(page.subarray(2), result.length);
      if (next.length > total || (next.length === result.length && next.length < total)) {
        throw new Error("Invalid secure configuration page.");
      }
      result = next;
    } while (result.length < expected);
    return new TextDecoder().decode(result);
  }
}
