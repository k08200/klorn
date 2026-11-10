/**
 * Sample emails. The email text itself stays English on purpose: it is the
 * input the judge reads, not interface copy (the label is translated).
 */

export interface PlaygroundSample {
  /** i18n key suffix: playground.samples.<id> */
  readonly id: "investor" | "newsletter" | "receipt" | "teammate" | "meeting";
  readonly from: string;
  readonly subject: string;
  readonly body: string;
}

export const SAMPLES: readonly PlaygroundSample[] = [
  {
    id: "investor",
    from: "Dana Park <dana@northwind.vc>",
    subject: "Term sheet — can we talk today?",
    body: "Saw your launch. I'd like to move fast on the round — can you do 20 min today or tomorrow? The partner meeting is Thursday.",
  },
  {
    id: "newsletter",
    from: "Morning Brew <crew@morningbrew.com>",
    subject: "☕ The Fed blinked",
    body: "Markets rallied on rate-cut hopes. Plus: the AI bubble debate heats up. View in browser · Unsubscribe.",
  },
  {
    id: "receipt",
    from: "Stripe <receipts@stripe.com>",
    subject: "Your receipt from Acme Inc.",
    body: "Thanks for your payment of $20.00. This is an automated message, please do not reply.",
  },
  {
    id: "teammate",
    from: "Min <min@yourcompany.com>",
    subject: "Quick q on the deploy",
    body: "Did the migration run on prod yet? Want to make sure before I push the web build.",
  },
  {
    id: "meeting",
    from: "Alex Kim <alex@yourcompany.com>",
    subject: "Quarterly review — Thursday 14:00?",
    body: "Can we hold the quarterly review on Thursday at 14:00 for 45 minutes? If that doesn't work, suggest another time and I'll send an invite.",
  },
];
