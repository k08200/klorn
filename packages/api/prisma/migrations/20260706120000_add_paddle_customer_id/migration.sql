-- AlterTable: Paddle Billing (web MoR) customer id. Set by the paddle
-- webhook on the first subscription event; used for the customer portal and
-- as the fallback user mapping for events without custom_data.userId.
ALTER TABLE "User" ADD COLUMN "paddleCustomerId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_paddleCustomerId_key" ON "User"("paddleCustomerId");
