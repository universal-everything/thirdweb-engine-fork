import { Type, type Static } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { StatusCodes } from "http-status-codes";
import { updateConfiguration } from "../../../../shared/db/configuration/update-configuration";
import { WalletType } from "../../../../shared/schemas/wallet";
import { getConfig } from "../../../../shared/utils/cache/get-config";
import { createCustomError } from "../../../middleware/error";
import { standardResponseSchema } from "../../../schemas/shared-api-schemas";
import { responseBodySchema } from "./get";

const requestBodySchema = Type.Union([
  Type.Object({
    awsAccessKeyId: Type.String(),
    awsSecretAccessKey: Type.String(),
    awsRegion: Type.String(),
  }),
  Type.Object({
    gcpApplicationProjectId: Type.String(),
    gcpKmsLocationId: Type.String(),
    gcpKmsKeyRingId: Type.String(),
    // Optional: omit both when relying on Application Default Credentials.
    gcpApplicationCredentialEmail: Type.Optional(Type.String()),
    gcpApplicationCredentialPrivateKey: Type.Optional(Type.String()),
  }),
  Type.Object({
    circleApiKey: Type.String(),
  }),
]);

requestBodySchema.examples = [
  {
    type: WalletType.local,
  },
  {
    type: WalletType.awsKms,
    awsAccessKeyId: "<your-aws-access-key-id>",
    awsSecretAccessKey: "<your-aws-secret-access-key>",
    awsRegion: "<your-aws-region>",
  },
  {
    type: WalletType.gcpKms,
    gcpApplicationProjectId: "<your-gcp-application-project-id>",
    gcpKmsLocationId: "<your-gcp-kms-location-id>",
    gcpKmsKeyRingId: "<your-gcp-key-ring-id>",
    gcpApplicationCredentialEmail: "<your-gcp-application-credential-email>",
    gcpApplicationCredentialPrivateKey:
      "<your-gcp-application-credential-private-key>",
  },
];

export async function updateWalletsConfiguration(fastify: FastifyInstance) {
  fastify.route<{
    Body: Static<typeof requestBodySchema>;
    Reply: Static<typeof responseBodySchema>;
  }>({
    method: "POST",
    url: "/configuration/wallets",
    schema: {
      summary: "Update wallets configuration",
      description: "Update wallets configuration",
      tags: ["Configuration"],
      operationId: "updateWalletsConfiguration",
      body: requestBodySchema,
      response: {
        ...standardResponseSchema,
        [StatusCodes.OK]: responseBodySchema,
      },
    },
    handler: async (req, res) => {
      if ("awsAccessKeyId" in req.body) {
        if (
          !req.body.awsAccessKeyId ||
          !req.body.awsSecretAccessKey ||
          !req.body.awsRegion
        ) {
          throw createCustomError(
            "Please specify all AWS KMS configuration.",
            StatusCodes.BAD_REQUEST,
            "BAD_REQUEST",
          );
        }
        await updateConfiguration({
          awsAccessKeyId: req.body.awsAccessKeyId,
          awsSecretAccessKey: req.body.awsSecretAccessKey,
          awsRegion: req.body.awsRegion,
        });
      }

      if ("gcpApplicationProjectId" in req.body) {
        if (
          !req.body.gcpApplicationProjectId ||
          !req.body.gcpKmsLocationId ||
          !req.body.gcpKmsKeyRingId
        ) {
          throw createCustomError(
            "Please specify gcpApplicationProjectId, gcpKmsLocationId, and gcpKmsKeyRingId.",
            StatusCodes.BAD_REQUEST,
            "BAD_REQUEST",
          );
        }

        // Email + privateKey are optional. When both are absent, Engine
        // signs via Application Default Credentials (e.g. the Cloud Run
        // runtime service account). When provided, both must be set
        // together so we don't half-configure a static credential.
        const { gcpApplicationCredentialEmail, gcpApplicationCredentialPrivateKey } =
          req.body;
        if (
          (gcpApplicationCredentialEmail && !gcpApplicationCredentialPrivateKey) ||
          (!gcpApplicationCredentialEmail && gcpApplicationCredentialPrivateKey)
        ) {
          throw createCustomError(
            "gcpApplicationCredentialEmail and gcpApplicationCredentialPrivateKey must be provided together (or both omitted to use Application Default Credentials).",
            StatusCodes.BAD_REQUEST,
            "BAD_REQUEST",
          );
        }

        await updateConfiguration({
          gcpApplicationProjectId: req.body.gcpApplicationProjectId,
          gcpKmsLocationId: req.body.gcpKmsLocationId,
          gcpKmsKeyRingId: req.body.gcpKmsKeyRingId,
          gcpApplicationCredentialEmail: gcpApplicationCredentialEmail ?? null,
          gcpApplicationCredentialPrivateKey:
            gcpApplicationCredentialPrivateKey ?? null,
        });
      }

      if ("circleApiKey" in req.body) {
        await updateConfiguration({
          walletProviderConfigs: {
            circle: {
              apiKey: req.body.circleApiKey,
            },
          },
        });
      }

      const config = await getConfig(false);

      const { legacyWalletType_removeInNextBreakingChange, aws, gcp } =
        config.walletConfiguration;

      res.status(StatusCodes.OK).send({
        result: {
          type: legacyWalletType_removeInNextBreakingChange,
          awsAccessKeyId: aws?.awsAccessKeyId ?? null,
          awsRegion: aws?.defaultAwsRegion ?? null,
          gcpApplicationProjectId: gcp?.defaultGcpApplicationProjectId ?? null,
          gcpKmsLocationId: gcp?.defaultGcpKmsLocationId ?? null,
          gcpKmsKeyRingId: gcp?.defaultGcpKmsKeyRingId ?? null,
          gcpApplicationCredentialEmail:
            gcp?.gcpApplicationCredentialEmail ?? null,
        },
      });
    },
  });
}
