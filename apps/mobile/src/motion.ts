import { useEffect, useState } from "react";
import { AccessibilityInfo, Keyboard } from "react-native";

/** Whether the person asked the system for less motion: what would slide then simply appears. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduced);
    const watching = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => watching.remove();
  }, []);
  return reduced;
}

/** Whether the keyboard is up, told as it starts to move so what sits above it moves with it. */
export function useKeyboardUp(): boolean {
  const [up, setUp] = useState(false);
  useEffect(() => {
    const shown = Keyboard.addListener("keyboardWillShow", () => setUp(true));
    const hidden = Keyboard.addListener("keyboardWillHide", () => setUp(false));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);
  return up;
}
