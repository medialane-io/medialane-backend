export async function guardianRecipients(
  accountIds: string[],
  emailOf: (accountId: string) => Promise<string | null>,
): Promise<string[]> {
  const emails = await Promise.all(accountIds.map(emailOf));
  return [...new Set(emails.filter((email): email is string => Boolean(email)))];
}
