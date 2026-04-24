import { describe, expect, it } from 'vitest';
import { unwrapResponse } from './api.service';
import { ApiError, ResponseCode, type ResponseData } from './api.types';

describe('unwrapResponse', () => {
  it('returns data on success', () => {
    const res: ResponseData<{ id: number }> = {
      status: true,
      data: { id: 42 },
      message: 'ok',
      responseCode: ResponseCode.Success,
    };
    expect(unwrapResponse(res)).toEqual({ id: 42 });
  });

  it('throws ApiError with code when status is false', () => {
    const res: ResponseData<unknown> = {
      status: false,
      data: null,
      message: 'Not found',
      responseCode: ResponseCode.NotFound,
    };
    expect(() => unwrapResponse(res)).toThrow(ApiError);
    try {
      unwrapResponse(res);
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe(ResponseCode.NotFound);
      expect((err as ApiError).isNotFound).toBe(true);
      expect((err as ApiError).isValidation).toBe(false);
      expect((err as ApiError).message).toBe('Not found');
    }
  });

  it('classifies validation errors', () => {
    const res: ResponseData<unknown> = {
      status: false,
      data: null,
      message: 'bad payload',
      responseCode: ResponseCode.ValidationError,
    };
    try {
      unwrapResponse(res);
    } catch (err) {
      expect((err as ApiError).isValidation).toBe(true);
    }
  });

  it('falls back to UNKNOWN + "Request failed" when the envelope is bare', () => {
    const res: ResponseData<unknown> = {
      status: false,
      data: null,
      message: null,
      responseCode: null,
    };
    try {
      unwrapResponse(res);
    } catch (err) {
      expect((err as ApiError).code).toBe('UNKNOWN');
      expect((err as ApiError).message).toBe('Request failed');
    }
  });
});
