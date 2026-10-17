import { PRO_PRICE_WEB } from "../lib/pricing";

/** Where cancellation and refund requests are received. */
export const BILLING_CONTACT_EMAIL = "k0820086@gmail.com";

/**
 * The refund policy, in one place.
 *
 * It is rendered twice: inside the "Billing, Cancellation, and Refunds" section
 * of the Terms, and as the standalone /refund page that Paddle's domain review
 * looks for. Keeping one component means the two cannot drift the way the price
 * string did in 2026-08 (see lib/pricing.ts).
 */
export default function RefundPolicy() {
  return (
    <>
      <p>
        Klorn Pro is a monthly subscription at {PRO_PRICE_WEB}/month, billed through Paddle. Paddle
        is the merchant of record for these purchases: Paddle handles the payment, issues the
        receipt, and appears on your card or bank statement.
      </p>
      <p>
        Subscriptions bought inside the Klorn app for iPhone, iPad or Android are sold by Apple (App
        Store) or Google (Google Play) instead, at the price the store shows, and billed to your
        store account. Cancel those in your App Store or Google Play subscription settings; their
        refunds are handled by Apple or Google under the store&apos;s own policy. The Paddle terms
        below apply to subscriptions bought on the web.
      </p>
      <p>
        New subscriptions start with a 7-day free trial. You are not charged during the trial.
        Cancel before it ends and you are never billed.
      </p>
      <ul className="list-disc space-y-2 pl-5">
        <li>
          <strong>Cancel anytime, yourself.</strong> Settings &rarr; Subscription, or the Billing
          page, has a &ldquo;Cancel subscription&rdquo; button — no email required. Cancellation
          stops future renewals; your Pro access continues until the end of the period you already
          paid for, and you can undo it any time before that date.
        </li>
        <li>
          <strong>14-day refund on a first paid month.</strong> If Klorn is not for you, email us
          within 14 days of your first charge and we will refund it in full — no explanation needed.
        </li>
        <li>
          <strong>After that window,</strong> paid periods are non-refundable by default, because
          access was available for the period. If something went wrong on our side — an outage, a
          failed sync, a charge you did not expect — write to us and we will make it right.
        </li>
        <li>
          <strong>Statutory rights are unaffected.</strong> Where local consumer law grants you a
          stronger right of withdrawal or refund, that law applies and overrides this section. In
          the Republic of Korea this includes the withdrawal rights under the Act on Consumer
          Protection in Electronic Commerce.
        </li>
      </ul>
      <p>
        To request a refund — or to cancel if you cannot reach the in-app button — email{" "}
        <a
          className="text-accent-deep hover:text-accent-deeper"
          href={`mailto:${BILLING_CONTACT_EMAIL}`}
        >
          {BILLING_CONTACT_EMAIL}
        </a>{" "}
        from the address on your Klorn account. Refunds are returned to the original payment method;
        the time it takes to appear depends on your bank.
      </p>
      <p>
        Klorn&apos;s free tier remains free, and the source is available under AGPL for self-hosting
        — self-hosted instances involve no billing relationship with us.
      </p>
    </>
  );
}
