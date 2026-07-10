'use strict';

const http = require('node:http');
const { URL } = require('node:url');

const {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RoleApplicationError,
  UnauthorizedError,
  ValidationError,
} = require('./errors');

const APPLICATION_STATUSES = new Set(['submitted', 'under_review', 'approved', 'rejected']);
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_EVIDENCE_URLS = 10;

function requiredString(value, field, maxLength) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${field} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new ValidationError(`${field} must be at most ${maxLength} characters`);
  }
  return normalized;
}

function optionalString(value, field, maxLength) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  return requiredString(value, field, maxLength);
}

function validateEvidenceUrls(value) {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_URLS) {
    throw new ValidationError(`evidenceUrls must contain at most ${MAX_EVIDENCE_URLS} URLs`);
  }

  return value.map((candidate) => {
    const normalized = requiredString(candidate, 'evidenceUrls item', 2048);
    let parsed;
    try {
      parsed = new URL(normalized);
    } catch {
      throw new ValidationError('evidenceUrls items must be valid URLs');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new ValidationError('evidenceUrls items must use http or https');
    }
    return parsed.toString();
  });
}

function validateSubmission(body, principal) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('A JSON object is required');
  }

  const experience = optionalString(body.experience, 'experience', 5000);
  const evidenceUrls = validateEvidenceUrls(body.evidenceUrls);

  return {
    roleId: requiredString(body.roleId, 'roleId', 100),
    applicantId: requiredString(principal.id, 'applicantId', 200),
    applicantName: requiredString(principal.name || principal.id, 'applicantName', 200),
    motivation: requiredString(body.motivation, 'motivation', 5000),
    ...(experience ? { experience } : {}),
    ...(evidenceUrls ? { evidenceUrls } : {}),
  };
}

function validateReview(body, principal) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('A JSON object is required');
  }
  if (!['approved', 'rejected'].includes(body.decision)) {
    throw new ValidationError('decision must be approved or rejected');
  }
  if (!Number.isInteger(body.expectedVersion) || body.expectedVersion < 1) {
    throw new ValidationError('expectedVersion must be a positive integer');
  }

  const reviewNote = optionalString(body.reviewNote, 'reviewNote', 5000);

  return {
    decision: body.decision,
    expectedVersion: body.expectedVersion,
    reviewedBy: requiredString(principal.id, 'reviewer id', 200),
    ...(reviewNote ? { reviewNote } : {}),
  };
}

async function readJsonBody(request) {
  let size = 0;
  const chunks = [];

  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new ValidationError('Request body is too large');
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    throw new ValidationError('A JSON request body is required');
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ValidationError('Request body must be valid JSON');
  }
}

function defaultLocalAuthenticator(request) {
  const id = request.headers['x-local-user-id'];
  if (typeof id !== 'string' || id.trim() === '') {
    return null;
  }

  const name = request.headers['x-local-user-name'];
  return {
    id: id.trim(),
    name: typeof name === 'string' && name.trim() ? name.trim() : id.trim(),
    isReviewer: request.headers['x-local-reviewer'] === 'true',
  };
}

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  response.end(body);
}

function applicationPath(pathname) {
  const match = pathname.match(/^\/api\/role-applications\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function reviewPath(pathname) {
  const match = pathname.match(/^\/api\/role-applications\/([^/]+)\/review$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function requirePrincipal(authenticator, request) {
  const principal = authenticator(request);
  if (!principal || typeof principal.id !== 'string' || principal.id.trim() === '') {
    throw new UnauthorizedError();
  }
  return {
    ...principal,
    id: principal.id.trim(),
    name: typeof principal.name === 'string' && principal.name.trim() ? principal.name.trim() : principal.id.trim(),
    isReviewer: principal.isReviewer === true,
  };
}

function requireReviewer(principal) {
  if (!principal.isReviewer) {
    throw new ForbiddenError();
  }
}

async function getVisibleApplication(repository, id, principal) {
  const application = await repository.get(id);
  if (!application || (!principal.isReviewer && application.applicantId !== principal.id)) {
    throw new NotFoundError();
  }
  return application;
}

function createRoleApplicationServer({ repository, authenticate = defaultLocalAuthenticator } = {}) {
  if (!repository) {
    throw new TypeError('repository is required');
  }
  if (typeof authenticate !== 'function') {
    throw new TypeError('authenticate must be a function');
  }

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const principal = requirePrincipal(authenticate, request);

      if (request.method === 'POST' && url.pathname === '/api/role-applications') {
        const body = await readJsonBody(request);
        const application = await repository.create(validateSubmission(body, principal));
        sendJson(response, 201, { application });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/role-applications/mine') {
        const applications = await repository.list({ applicantId: principal.id });
        sendJson(response, 200, { applications });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/role-applications') {
        requireReviewer(principal);
        const status = url.searchParams.get('status') || undefined;
        if (status && !APPLICATION_STATUSES.has(status)) {
          throw new ValidationError('status is not a valid role application status');
        }
        const roleId = url.searchParams.get('roleId') || undefined;
        if (roleId && roleId.length > 100) {
          throw new ValidationError('roleId must be at most 100 characters');
        }
        const applications = await repository.list({ status, roleId });
        sendJson(response, 200, { applications });
        return;
      }

      const reviewId = reviewPath(url.pathname);
      if (request.method === 'PATCH' && reviewId) {
        requireReviewer(principal);
        const body = await readJsonBody(request);
        const application = await repository.review(reviewId, validateReview(body, principal));
        sendJson(response, 200, { application });
        return;
      }

      const detailId = applicationPath(url.pathname);
      if (request.method === 'GET' && detailId) {
        const application = await getVisibleApplication(repository, detailId, principal);
        sendJson(response, 200, { application });
        return;
      }

      sendJson(response, 404, { error: { code: 'not_found', message: 'Route not found' } });
    } catch (error) {
      if (error instanceof RoleApplicationError) {
        const headers = error.statusCode === 401 ? { 'www-authenticate': 'LocalSession' } : {};
        sendJson(response, error.statusCode, { error: { code: error.code, message: error.message } }, headers);
        return;
      }

      console.error(error);
      sendJson(response, 500, { error: { code: 'internal_error', message: 'Internal server error' } });
    }
  });
}

module.exports = {
  createRoleApplicationServer,
  defaultLocalAuthenticator,
  validateReview,
  validateSubmission,
};
