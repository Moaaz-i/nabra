// Imported from `./settings` rather than `./engine`: the schema is standalone,
// and this keeps the preset storage testable without the Web Audio graph.
import { sanitizeSettings, type VoiceSettings } from "./settings";

export type StudioPreset = {
  id: string;
  name: string;
  hint: string;
  settings: Partial<VoiceSettings>;
};

export const STUDIO_PRESETS: StudioPreset[] = [
  {
    id: "natural",
    name: "أصلي",
    hint: "صوتك كما هو مع سلسلة نظيفة",
    settings: {
      mode: "manual",
      manualSemitones: 0,
      formant: 0,
      highpassHz: 70,
      lowpassHz: 18000,
      deess: 0.15,
      presence: 1,
      warmth: 0,
      compress: 0.25,
      agc: false,
    },
  },
  {
    id: "broadcast",
    name: "بث",
    hint: "إذاعي: حضور وضغط وتتبع مستوى",
    settings: {
      mode: "manual",
      manualSemitones: 0,
      formant: 0,
      highpassHz: 90,
      lowpassHz: 14000,
      deess: 0.45,
      presence: 3.5,
      warmth: 1.5,
      compress: 0.35,
      agc: false,
    },
  },
  {
    id: "deep",
    name: "عميق",
    hint: "طبقة أخفض وطابع أثقل",
    settings: {
      mode: "manual",
      manualSemitones: -5,
      formant: -2.4,
      highpassHz: 60,
      lowpassHz: 12000,
      deess: 0.2,
      presence: -0.5,
      warmth: 4,
      compress: 0.4,
      agc: false,
    },
  },
  {
    id: "bright",
    name: "حاد",
    hint: "طبقة أعلى ووضوح أكبر",
    settings: {
      mode: "manual",
      manualSemitones: 4,
      formant: 2,
      highpassHz: 100,
      lowpassHz: 16000,
      deess: 0.35,
      presence: 4.5,
      warmth: -1,
      compress: 0.35,
      agc: false,
    },
  },
  {
    id: "warm",
    name: "دافئ",
    hint: "جسم منخفض بدون تلوين حاد",
    settings: {
      mode: "manual",
      manualSemitones: -1,
      formant: -0.6,
      highpassHz: 55,
      lowpassHz: 11000,
      deess: 0.25,
      presence: 0.5,
      warmth: 5,
      compress: 0.4,
      agc: false,
    },
  },
  {
    id: "clear",
    name: "واضح",
    hint: "قطع الرنين وتحسين الكلام",
    settings: {
      mode: "manual",
      manualSemitones: 0,
      formant: 0.4,
      highpassHz: 110,
      lowpassHz: 15000,
      deess: 0.55,
      presence: 5,
      warmth: 0,
      compress: 0.5,
      agc: false,
    },
  },
  {
    id: "radio",
    name: "راديو",
    hint: "نطاق ضيق بأسلوب لاسلكي",
    settings: {
      mode: "manual",
      manualSemitones: 0,
      formant: 0.8,
      highpassHz: 280,
      lowpassHz: 3400,
      deess: 0.2,
      presence: 6,
      warmth: 2,
      compress: 0.4,
      agc: false,
    },
  },
  {
    id: "robot",
    name: "روبوط",
    hint: "معدني مع مسح موجة",
    settings: {
      mode: "manual",
      manualSemitones: 0,
      formant: 2.6,
      highpassHz: 120,
      lowpassHz: 8000,
      deess: 0.1,
      presence: 2,
      warmth: -2,
      compress: 0.5,
      chorusMix: 0.4,
      chorusRate: 0.6,
      chorusDepth: 0.5,
      distortion: 0.18,
      agc: false,
    },
  },
  {
    id: "soft",
    name: "ناعم",
    hint: "طبقة أعلى بطابع أنثوي خفيف",
    settings: {
      mode: "manual",
      manualSemitones: 3,
      formant: 3.4,
      highpassHz: 90,
      lowpassHz: 15000,
      deess: 0.5,
      presence: 4,
      warmth: 0.8,
      compress: 0.3,
      agc: false,
    },
  },
  {
    id: "monster",
    name: "وحش",
    hint: "عميق ثقيل مع اهتزاز",
    settings: {
      mode: "manual",
      manualSemitones: -7,
      formant: -3.6,
      highpassHz: 50,
      lowpassHz: 9000,
      deess: 0.1,
      presence: 1.5,
      warmth: 5,
      compress: 0.5,
      chorusMix: 0.2,
      chorusRate: 0.35,
      chorusDepth: 0.9,
      agc: false,
    },
  },
  {
    id: "choir",
    name: "جوقة",
    hint: "طبقات عريضة بأثر خلفي",
    settings: {
      mode: "manual",
      manualSemitones: 2,
      formant: 0.5,
      highpassHz: 90,
      lowpassHz: 14000,
      deess: 0.2,
      presence: 2,
      warmth: 2,
      compress: 0.35,
      chorusMix: 0.55,
      chorusRate: 1.4,
      chorusDepth: 0.5,
      reverbMix: 0.28,
      reverbTime: 2.2,
      delayMix: 0.12,
      delayTime: 0.4,
      delayFeedback: 0.35,
      agc: false,
    },
  },
  {
    id: "cinema",
    name: "سينما",
    hint: "تعليق صوتي عميق وواضح",
    settings: {
      mode: "manual",
      manualSemitones: -2,
      formant: -1.4,
      highpassHz: 70,
      lowpassHz: 13000,
      deess: 0.35,
      presence: 3,
      warmth: 3,
      compress: 0.45,
      reverbMix: 0.15,
      reverbTime: 1.8,
      agc: true,
    },
  },
];

const CUSTOM_STORAGE_KEY = "nabra-custom-presets";

export type CustomPreset = {
  id: string;
  name: string;
  settings: Partial<VoiceSettings>;
};

/**
 * Custom presets come from localStorage and from files the user picked, so
 * neither the entry count nor any single field can be trusted. Anything
 * unusable is dropped, duplicate ids are made unique, and every knob is
 * range-checked before it can reach the audio graph.
 */
export function loadCustomPresets(): CustomPreset[] {
  let parsed: unknown;
  try {
    const raw = localStorage.getItem(CUSTOM_STORAGE_KEY);
    if (!raw) return [];
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const out: CustomPreset[] = [];
  parsed.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    const raw = entry as Record<string, unknown>;
    if (!raw.settings || typeof raw.settings !== "object") return;
    const name =
      typeof raw.name === "string" && raw.name.trim()
        ? raw.name.slice(0, 60)
        : `مسبق ${index + 1}`;
    const id =
      typeof raw.id === "string" && raw.id && !seen.has(raw.id)
        ? raw.id
        : `custom-${index}-${Math.random().toString(36).slice(2, 8)}`;
    seen.add(id);
    out.push({ id, name, settings: sanitizeSettings(raw.settings) });
  });
  return out;
}

function persistCustom(presets: CustomPreset[]) {
  try {
    localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify(presets));
  } catch {
    // Quota exceeded or storage disabled: the in-memory list still works.
  }
}

/** Writes the whole list in one go, for bulk changes such as an import. */
export function saveCustomPresets(presets: CustomPreset[]): CustomPreset[] {
  const unique = [...new Map(presets.map((p) => [p.id, p])).values()];
  persistCustom(unique);
  return unique;
}

export function upsertCustomPreset(preset: CustomPreset): CustomPreset[] {
  const presets = loadCustomPresets();
  const index = presets.findIndex((p) => p.id === preset.id);
  if (index >= 0) presets[index] = preset;
  else presets.push(preset);
  persistCustom(presets);
  return presets;
}

export function removeCustomPreset(id: string): CustomPreset[] {
  const presets = loadCustomPresets().filter((p) => p.id !== id);
  persistCustom(presets);
  return presets;
}
