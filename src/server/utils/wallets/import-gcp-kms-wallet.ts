import { createWalletDetails } from "../../../shared/db/wallets/create-wallet-details";
import { WalletType } from "../../../shared/schemas/wallet";
import { thirdwebClient } from "../../../shared/utils/sdk";
import { getGcpKmsAccount } from "./get-gcp-kms-account";

interface ImportGcpKmsWalletParams {
  gcpKmsResourcePath: string;
  label?: string;
  // Both fields are optional. When either is missing, Engine signs via
  // Application Default Credentials (e.g. Cloud Run runtime SA) and stores
  // null in the DB for that wallet's credential columns.
  credentials: {
    email: string | null;
    privateKey: string | null;
  };
}

/**
 * Import a GCP KMS wallet, and store it into the database
 *
 * When credentials.email and credentials.privateKey are both provided, they
 * are stored with the wallet details and used to construct the KMS client.
 * Otherwise the KMS client falls back to Application Default Credentials.
 */
export const importGcpKmsWallet = async ({
  label,
  gcpKmsResourcePath,
  credentials,
}: ImportGcpKmsWalletParams) => {
  const useStaticCreds = !!(credentials.email && credentials.privateKey);

  const account = await getGcpKmsAccount({
    client: thirdwebClient,
    name: gcpKmsResourcePath,
    clientOptions: useStaticCreds
      ? {
          credentials: {
            client_email: credentials.email as string,
            private_key: credentials.privateKey as string,
          },
        }
      : undefined,
  });

  const walletAddress = account.address;

  await createWalletDetails({
    type: WalletType.gcpKms,
    address: walletAddress,
    label,
    gcpKmsResourcePath,

    gcpApplicationCredentialEmail: useStaticCreds ? credentials.email : null,
    gcpApplicationCredentialPrivateKey: useStaticCreds
      ? credentials.privateKey
      : null,
  });

  return walletAddress;
};
