-- Automatic inflow attribution captured by the funnel itself (utm_* params,
-- referrer host, landing path), separate from the self-reported `source`
-- question. Additive and nullable — no signup can fail because of it, and
-- like `source` it is first-touch: never overwritten once set.
ALTER TABLE "Waitlist" ADD COLUMN "attribution" VARCHAR(300);
