// _shared/linear.ts — the few Linear API calls the edge functions make.
// -----------------------------------------------------------------------------
// report-problem opens issues and uploads log files; delete-account deletes
// those issues again on an erasure request. Both go through here so there is
// one copy of the GraphQL and of the key handling.
//
// LINEAR_API_KEY is a personal API key (Linear → Settings → Security & access)
// on a workspace member who can create issues in team THE. It is a function
// secret and never reaches the app. Personal keys go in the Authorization
// header bare — the "Bearer" prefix is only for OAuth tokens.

const ENDPOINT = 'https://api.linear.app/graphql';

export function linearKey(): string {
  return Deno.env.get('LINEAR_API_KEY') ?? '';
}

type GqlResult<T> = { data?: T; errors?: { message: string }[] };

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: linearKey() },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as GqlResult<T>;
  if (!res.ok || body.errors?.length || !body.data) {
    const why = body.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`;
    throw new Error(`linear: ${why}`);
  }
  return body.data;
}

/**
 * Upload one text file to Linear's storage and return the URL to link from an
 * issue. Two steps: ask for a signed upload URL, then PUT the bytes with the
 * headers Linear hands back. `size` must be the exact byte length.
 */
export async function uploadText(filename: string, text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const contentType = 'text/plain';
  const data = await gql<{
    fileUpload: {
      success: boolean;
      uploadFile: { uploadUrl: string; assetUrl: string; headers: { key: string; value: string }[] };
    };
  }>(
    `mutation($contentType: String!, $filename: String!, $size: Int!) {
       fileUpload(contentType: $contentType, filename: $filename, size: $size) {
         success
         uploadFile { uploadUrl assetUrl headers { key value } }
       }
     }`,
    { contentType, filename, size: bytes.byteLength },
  );
  const up = data.fileUpload?.uploadFile;
  if (!data.fileUpload?.success || !up) throw new Error('linear: fileUpload refused');
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=31536000',
  };
  for (const h of up.headers ?? []) headers[h.key] = h.value;
  const put = await fetch(up.uploadUrl, {
    method: 'PUT',
    headers,
    body: bytes,
    signal: AbortSignal.timeout(30_000),
  });
  if (!put.ok) throw new Error(`linear: upload PUT HTTP ${put.status}`);
  return up.assetUrl;
}

export type CreatedIssue = { id: string; identifier: string; url: string };

export async function createIssue(input: {
  teamId: string;
  title: string;
  description: string;
  labelIds: string[];
  projectId?: string;
}): Promise<CreatedIssue> {
  const data = await gql<{ issueCreate: { success: boolean; issue: CreatedIssue | null } }>(
    `mutation($input: IssueCreateInput!) {
       issueCreate(input: $input) { success issue { id identifier url } }
     }`,
    { input },
  );
  const issue = data.issueCreate?.issue;
  if (!data.issueCreate?.success || !issue) throw new Error('linear: issueCreate refused');
  return issue;
}

/**
 * Delete an issue. Asks for a permanent delete first (skips Linear's 30-day
 * trash, admin keys only); a key that may not do that still moves it to the
 * trash, which Linear empties after 30 days.
 */
export async function deleteIssue(id: string): Promise<void> {
  try {
    await gql(`mutation($id: String!) { issueDelete(id: $id, permanentlyDelete: true) { success } }`, { id });
  } catch {
    await gql(`mutation($id: String!) { issueDelete(id: $id) { success } }`, { id });
  }
}
