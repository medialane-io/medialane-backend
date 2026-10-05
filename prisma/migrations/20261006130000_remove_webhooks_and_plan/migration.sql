-- Webhooks and the plan are removed. The migration stops if any webhook endpoint exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "WebhookEndpoint") THEN
    RAISE EXCEPTION 'Webhook endpoints exist';
  END IF;
END
$$;

DROP TABLE "WebhookDelivery";
DROP TABLE "WebhookEndpoint";
DROP TYPE "WebhookEventType";
DROP TYPE "WebhookEndpointStatus";

ALTER TABLE "ApiCredits" DROP COLUMN "plan";
DROP TYPE "Plan";
