export type TemplateId = "CLASSIC" | "SPLIT" | "COUNTDOWN";

export type TemplatePreset = {
  id: TemplateId;
  label: string;
  blurb: string;
  usesImage: boolean;
  colors: { backgroundColor: string; textColor: string; buttonColor: string; buttonTextColor: string };
  /** Applied when the merchant picks the template and the field is still empty. */
  defaults: { subtitle?: string; showCountdown?: boolean; declineText?: string };
};

export const TEMPLATES: TemplatePreset[] = [
  {
    id: "CLASSIC",
    label: "Classic",
    blurb: "Centred card. Simple and quick.",
    usesImage: false,
    colors: { backgroundColor: "#ffffff", textColor: "#1a1a1a", buttonColor: "#1a1a1a", buttonTextColor: "#ffffff" },
    defaults: { showCountdown: false },
  },
  {
    id: "SPLIT",
    label: "Split image",
    blurb: "Image on the left, dark form on the right, “No, thanks” link.",
    usesImage: true,
    colors: { backgroundColor: "#000000", textColor: "#f3e9d8", buttonColor: "#d9c7ae", buttonTextColor: "#1a1a1a" },
    defaults: { showCountdown: false, declineText: "No, thanks!" },
  },
  {
    id: "COUNTDOWN",
    label: "Countdown offer",
    blurb: "Image, “limited time” line and a countdown timer.",
    usesImage: true,
    colors: { backgroundColor: "#b9d4ea", textColor: "#111111", buttonColor: "#000000", buttonTextColor: "#ffffff" },
    defaults: { subtitle: "LIMITED TIME OFFER", showCountdown: true },
  },
];
