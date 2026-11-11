/**
 * Phone normalization to E.164.
 *
 * Matching contacts across companies relies on this: two inputs that denote
 * the same number must normalize to the same string, and anything we cannot
 * interpret with confidence is rejected instead of guessed.
 */

export type PhoneResult =
  | { ok: true; e164: string }
  | { ok: false; reason: "empty" | "invalid" };

const E164 = /^\+[1-9]\d{6,14}$/;

// Arabic-Indic (U+0660–0669) and Extended Arabic-Indic / Persian (U+06F0–06F9).
function toAsciiDigits(input: string): string {
  return input.replace(/[٠-٩۰-۹]/g, (ch) => {
    const code = ch.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

/**
 * @param input         what the user typed or imported
 * @param defaultCountryCode digits only, e.g. "974" — used for local numbers
 *
 * Accepted forms: "+974 5555 0001", "00974 5555 0001", "٠٠٩٧٤٥٥٥٥٠٠٠١",
 * "974 5555 0001" (country code without +, only when long enough to be
 * international), and local "5555 0001" / "05555 0001" (trunk 0 dropped).
 */
export function normalizePhone(input: string | null | undefined, defaultCountryCode = "974"): PhoneResult {
  if (input == null) return { ok: false, reason: "empty" };
  let s = toAsciiDigits(String(input)).trim();
  if (s === "") return { ok: false, reason: "empty" };

  // Only digits, spaces and common separators are allowed — reject letters,
  // extensions and anything else rather than silently dropping them.
  if (!/^[+\d\s().\-‎‏]+$/.test(s)) return { ok: false, reason: "invalid" };
  const hasPlus = s.startsWith("+");
  s = s.replace(/[^\d]/g, "");
  if (s === "") return { ok: false, reason: "invalid" };

  let digits: string;
  if (hasPlus) {
    digits = s;
  } else if (s.startsWith("00")) {
    digits = s.slice(2);
  } else if (s.startsWith(defaultCountryCode) && s.length >= defaultCountryCode.length + 7) {
    digits = s;
  } else {
    digits = defaultCountryCode + s.replace(/^0+/, "");
  }

  const e164 = "+" + digits;
  return E164.test(e164) ? { ok: true, e164 } : { ok: false, reason: "invalid" };
}

/** WhatsApp sends customer IDs as bare digits (e.g. "97455550001"). */
export function waIdToE164(waId: string): string | null {
  return /^[1-9]\d{6,14}$/.test(waId) ? "+" + waId : null;
}

export function e164ToWaId(e164: string): string | null {
  return E164.test(e164) ? e164.slice(1) : null;
}
