const TABS = [
  { href: "/app/popup", label: "Campaigns", key: "campaigns" },
  { href: "/app/popup/analytics", label: "Analytics", key: "analytics" },
  { href: "/app/popup/setup", label: "Setup", key: "setup" },
] as const;

/** Section switcher shown at the top of every Popup page. */
export function PopupSubnav({ active }: { active: (typeof TABS)[number]["key"] }) {
  return (
    <s-stack direction="inline" gap="base">
      {TABS.map((t) =>
        t.key === active ? (
          <s-text key={t.key} type="strong">{t.label}</s-text>
        ) : (
          <s-link key={t.key} href={t.href}>{t.label}</s-link>
        ),
      )}
    </s-stack>
  );
}
