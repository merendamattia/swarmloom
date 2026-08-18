-- Drop structured review columns in favour of the verbatim plain-text response.
ALTER TABLE "review" DROP COLUMN "verdict";
ALTER TABLE "review" DROP COLUMN "findings";
ALTER TABLE "review" ADD COLUMN "response" TEXT;
