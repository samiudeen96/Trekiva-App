/** Deep link into the theme editor with the App Embed pre-selected for activation. */
export function embedActivationUrl(shop: string, apiKey: string) {
  return `https://${shop}/admin/themes/current/editor?context=apps&activateAppId=${apiKey}/welcome-popup`;
}
