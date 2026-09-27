/**
 * Kaggle REST API definition shipped inline by the `kaggle-competition` bundle.
 *
 * The PUT-the-bytes step of the submit chain is a direct-URL `api.http.call` to
 * the Google resumable-upload URL the upload slot returns — it goes through the
 * bundle's `kaggle-data-fetch` binding (GCS egress), not this definition.
 *
 * @packageDocumentation
 */

export const KAGGLE_API_DEFINITION = {
  apiId: 'kaggle',
  definition: {
    name: 'Kaggle',
    baseUrl: 'https://www.kaggle.com',
    authKind: 'bearer' as const,
    endpoints: [
      {
        endpointId: 'list_competition_data_files',
        path: '/api/v1/competitions/data/list/{competitionName}',
        method: 'GET' as const,
        summary: "List a competition's data files. Response: { files: [{ name, totalBytes }] }.",
      },
      {
        endpointId: 'download_competition_data_file',
        path: '/api/v1/competitions/data/download/{competitionName}/{fileName}',
        method: 'GET' as const,
        summary:
          'Download one competition data file. Kaggle 302-redirects to a signed Google Cloud ' +
          'Storage URL; the binding follows the redirect and returns the file bytes. Pair with ' +
          'response.saveTo to write straight to memory.',
      },
      {
        endpointId: 'request_submission_upload',
        name: 'Request submission upload slot',
        path: '/api/v1/blobs/upload',
        method: 'POST' as const,
        summary:
          'Request a resumable upload slot for a submission file. Response: { token, ' +
          'createUrl }. PUT the file bytes to createUrl (a Google resumable-upload URL), ' +
          'then finalize with submit_to_competition using the token.',
        body: {
          contentType: 'application/json' as const,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'name', 'contentLength', 'lastModifiedEpochSeconds'],
            properties: {
              type: { const: 'inbox', description: 'Always the literal string "inbox".' },
              name: { type: 'string', description: 'Submission file name, e.g. "submission.csv".' },
              contentLength: {
                type: 'integer',
                description:
                  'File size in bytes. MUST equal the file byte length — it pins the resumable upload session.',
              },
              lastModifiedEpochSeconds: {
                type: 'integer',
                description: 'File last-modified time as Unix epoch seconds.',
              },
            },
          },
        },
      },
      {
        endpointId: 'submit_to_competition',
        name: 'Finalize competition submission',
        path: '/api/v1/competitions/submissions/submit/{competitionName}',
        method: 'POST' as const,
        summary:
          'Finalize a competition submission from an uploaded blob token. Response: ' +
          '{ message, ref } where ref is the numeric submission id. Consumes daily quota.',
        body: {
          // The Kaggle submit endpoint is form-encoded only; a JSON body is rejected.
          contentType: 'application/x-www-form-urlencoded' as const,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['blobFileTokens', 'submissionDescription'],
            properties: {
              blobFileTokens: {
                type: 'array',
                items: { type: 'string' },
                description: 'Token(s) returned by request_submission_upload. Repeated field.',
              },
              submissionDescription: {
                type: 'string',
                description: 'Free-text submission message.',
              },
            },
          },
        },
      },
      {
        endpointId: 'list_competition_submissions',
        path: '/api/v1/competitions/submissions/list/{competitionName}',
        method: 'GET' as const,
        summary:
          "List a competition's submissions, most recent first. Element [0] is the latest. " +
          'Each entry: { ref, status (lowercase: complete | pending | error | …), publicScore ' +
          '(string number, "" until scored), errorDescription }.',
      },
    ],
    suggestedEgressPolicy: {
      allowedMethods: ['GET' as const, 'POST' as const],
      // download_competition_data_file 302s to a signed Google Cloud Storage
      // URL, so the binding must follow the redirect off www.kaggle.com.
      allowCrossHostRedirects: true,
      additionalHosts: [
        'storage.googleapis.com',
        '*.storage.googleapis.com',
        'storage.cloud.google.com',
        'www.googleapis.com',
        'uploads.googleapis.com',
      ],
      minResponseBodyBytes: 104_857_600,
    },
  },
  conflictPolicy: 'skip' as const,
};
