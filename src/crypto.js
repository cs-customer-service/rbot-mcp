import crypto from "node:crypto";

function evpBytesToKey(passphrase, salt) {
  const pass = Buffer.from(passphrase, "utf8");
  let block = Buffer.alloc(0);
  let out = Buffer.alloc(0);
  while (out.length < 48) {
    block = crypto.createHash("md5").update(Buffer.concat([block, pass, salt])).digest();
    out = Buffer.concat([out, block]);
  }
  return { key: out.subarray(0, 32), iv: out.subarray(32, 48) };
}

export function encryptText(plainText, passphrase) {
  const salt = crypto.randomBytes(8);
  const { key, iv } = evpBytesToKey(passphrase, salt);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const body = Buffer.concat([cipher.update(String(plainText), "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from("Salted__"), salt, body]).toString("base64");
}

export function decryptText(cipherText, passphrase) {
  const raw = Buffer.from(String(cipherText), "base64");
  if (raw.length < 17 || raw.subarray(0, 8).toString() !== "Salted__") throw new Error("Formato cifrado inválido");
  const { key, iv } = evpBytesToKey(passphrase, raw.subarray(8, 16));
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]).toString("utf8");
}

/** Corpo no formato aceito pelo requestBodyDecryptor. */
export const encryptedBody = (value, passphrase) => ({ encrypted: encryptText(JSON.stringify(value ?? {}), passphrase) });
