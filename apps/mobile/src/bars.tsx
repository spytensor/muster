/**
 * What a list inside the sheet needs so its content starts under the sheet's bar and ends
 * clear of the home indicator. (Before CHA-260 these screens were tabs under a glass header
 * and a glass tab bar; there is no tab bar now.)
 */
export function useBars() {
  return {
    scroll: { contentInsetAdjustmentBehavior: "automatic" as const },
    pad: { paddingBottom: 48 },
  };
}
