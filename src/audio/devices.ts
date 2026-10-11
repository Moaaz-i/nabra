/**
 * Matches the virtual audio devices this app can route into. Kept deliberately
 * narrow: a false positive makes the app label (and auto-select) a real
 * speaker or USB interface as "the virtual cable", which silently sends the
 * processed voice to the wrong place. Anchored terms such as `virtual` and
 * `cable` are therefore paired with a virtual-audio noun.
 */
const VIRTUAL_RE =
  /\bvac\b|vb[\s-]?audio|vb[\s-]?cable|black[\s-]?hole|voicemeeter|soundflower|loopback|scream|cubemix|goldwave|virtualbox|kronecker|dante|\bndi\b|multi[\s-]?output|aggregate|duplex|virtual[\s_-]*(audio|cable|mic|microphone|speaker|device|input|output)|\bcable\b|وهمي/i;

export function isVirtualDevice(label: string): boolean {
  return VIRTUAL_RE.test(label);
}

export function virtualDriverUrl(platform: string): string {
  return platform === "darwin"
    ? "https://existential.audio/blackhole/"
    : "https://vb-audio.com/Cable/";
}

export function virtualHint(platform: string): { title: string; body: string } {
  if (platform === "darwin") {
    return {
      title: "ماك — ثبّت مايكاً وهمياً مثل BlackHole",
      body: "بعد التثبيت اختر «BlackHole» كمخرج هنا، ثم في ديسكورد أو زووم اختر BlackHole كمايك.",
    };
  }
  if (platform === "win32") {
    return {
      title: "ويندوز — ثبّت VB-Audio Virtual Cable",
      body: "بعد التثبيت اختر «CABLE Output» كمخرج هنا، ثم في ديسكورد أو زووم اختر «CABLE Input» كمايك.",
    };
  }
  return {
    title: "ثبّت كابلاً صوتياً وهمياً على جهازك",
    body: "اختر جهاز الإخراج الوهمي هنا، ثم استخدم طرفه الآخر كمايك داخل التطبيقات.",
  };
}

export type DeviceLists = {
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
};

export function rawMicConstraints(deviceId?: string): MediaTrackConstraints {
  const audio: MediaTrackConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
  if (deviceId) audio.deviceId = { exact: deviceId };
  return audio;
}

export async function forceRawCapture(stream: MediaStream): Promise<void> {
  for (const track of stream.getAudioTracks()) {
    try {
      await track.applyConstraints({
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      });
    } catch {
      // some drivers reject extra constraints; keep the open track
    }
  }
}

export async function openMic(
  deviceId?: string,
): Promise<MediaStream> {
  const strict = rawMicConstraints(deviceId);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: strict,
      video: false,
    });
    await forceRawCapture(stream);
    return stream;
  } catch (err) {
    const name = err instanceof DOMException ? err.name : "";
    if (name === "OverconstrainedError" || name === "NotFoundError") {
      const relaxed: MediaTrackConstraints = { channelCount: 1 };
      if (deviceId) relaxed.deviceId = { exact: deviceId };
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: relaxed,
        video: false,
      });
      await forceRawCapture(stream);
      return stream;
    }
    throw err;
  }
}

/**
 * Whether the microphone permission has already been granted this session.
 *
 * Permission does not go away on its own, and re-opening the mic on every
 * `devicechange` fights with the stream the router is already holding: on an
 * exclusive driver the second open fails, the whole refresh throws, and the
 * device list gets reported as broken while the routing is perfectly healthy.
 * The explicit "grant access" button passes `force` to re-prompt anyway.
 */
let accessGranted = false;

export async function requestAudioAccess(force = false): Promise<void> {
  if (accessGranted && !force) return;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: rawMicConstraints(),
    video: false,
  });
  await forceRawCapture(stream);
  for (const track of stream.getTracks()) track.stop();
  accessGranted = true;
}

export async function listDevices(): Promise<DeviceLists> {
  const all = await navigator.mediaDevices.enumerateDevices();
  return {
    inputs: all.filter((d) => d.kind === "audioinput"),
    outputs: all.filter((d) => d.kind === "audiooutput"),
  };
}