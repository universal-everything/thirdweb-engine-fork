import type { Configuration } from "@prisma/client";
import type { Chain } from "thirdweb";
import type { WalletType } from "./wallet";

export type AwsWalletConfiguration = {
  awsAccessKeyId: string;
  awsSecretAccessKey: string;

  defaultAwsRegion: string;
};

export type GcpWalletConfiguration = {
  // Null when running with Application Default Credentials (ADC) — e.g.
  // Cloud Run with the runtime service account bound to roles/cloudkms.signer.
  gcpApplicationCredentialEmail: string | null;
  gcpApplicationCredentialPrivateKey: string | null;

  // these values are used as default so users don't need to specify them every time to the create wallet endpoint
  // for fetching a wallet, always trust the resource path in the wallet details
  // only use these values for creating a new wallet, when the resource path is not known
  defaultGcpKmsLocationId: string;
  defaultGcpKmsKeyRingId: string;
  defaultGcpApplicationProjectId: string;
};

export type CircleWalletConfiguration = {
  apiKey: string;
};

export interface ParsedConfig
  extends Omit<
    Configuration,
    | "awsAccessKeyId"
    | "awsSecretAccessKey"
    | "awsRegion"
    | "gcpApplicationProjectId"
    | "gcpKmsLocationId"
    | "gcpKmsKeyRingId"
    | "gcpApplicationCredentialEmail"
    | "gcpApplicationCredentialPrivateKey"
    | "contractSubscriptionsRetryDelaySeconds"
    | "mtlsCertificateEncrypted"
    | "mtlsPrivateKeyEncrypted"
    | "walletProviderConfigs"
  > {
  walletConfiguration: {
    aws: AwsWalletConfiguration | null;
    gcp: GcpWalletConfiguration | null;
    circle: CircleWalletConfiguration | null;
    legacyWalletType_removeInNextBreakingChange: WalletType;
  };
  contractSubscriptionsRequeryDelaySeconds: string;
  chainOverridesParsed: Chain[];
  mtlsCertificate: string | null;
  mtlsPrivateKey: string | null;
}
