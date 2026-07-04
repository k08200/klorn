import React from "react";
import { Composition, registerRoot } from "remotion";
import { Promo, PROMO_DURATION } from "./Promo";

const Root: React.FC = () => {
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(Composition, {
      id: "PromoEN",
      component: Promo as React.FC<Record<string, unknown>>,
      durationInFrames: PROMO_DURATION,
      fps: 30,
      width: 1920,
      height: 1080,
      defaultProps: { lang: "en" },
    }),
    React.createElement(Composition, {
      id: "PromoKO",
      component: Promo as React.FC<Record<string, unknown>>,
      durationInFrames: PROMO_DURATION,
      fps: 30,
      width: 1920,
      height: 1080,
      defaultProps: { lang: "ko" },
    }),
  );
};

registerRoot(Root);
