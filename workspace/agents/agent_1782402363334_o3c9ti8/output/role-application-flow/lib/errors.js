'use strict';

class RoleApplicationError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
  }
}

class ValidationError extends RoleApplicationError {
  constructor(message) {
    super(message, 400, 'validation_error');
  }
}

class UnauthorizedError extends RoleApplicationError {
  constructor(message = 'Authentication is required') {
    super(message, 401, 'unauthorized');
  }
}

class ForbiddenError extends RoleApplicationError {
  constructor(message = 'Reviewer access is required') {
    super(message, 403, 'forbidden');
  }
}

class NotFoundError extends RoleApplicationError {
  constructor(message = 'Role application not found') {
    super(message, 404, 'not_found');
  }
}

class ConflictError extends RoleApplicationError {
  constructor(message) {
    super(message, 409, 'conflict');
  }
}

module.exports = {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RoleApplicationError,
  UnauthorizedError,
  ValidationError,
};
