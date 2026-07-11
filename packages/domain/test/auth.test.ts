import { describe, expect, it } from 'vitest';
import {
  type Principal,
  SCOPES,
  assertWritableFields,
  authorize,
  authorizeContent,
  canAccessContentType,
  grantFor,
  maskDeniedFields,
} from '../src/index.js';

const unrestricted: Principal = {
  spaceId: 's1',
  kind: 'cma',
  scopes: [SCOPES.contentWrite],
};

const editor: Principal = {
  spaceId: 's1',
  kind: 'cma',
  scopes: [SCOPES.contentWrite, SCOPES.previewRead],
  contentGrants: [
    {
      contentTypeApiId: 'post',
      actions: ['read', 'write'],
      deniedFields: ['internalNotes'],
      readOnlyFields: ['slug'],
    },
    { contentTypeApiId: '*', actions: ['read'] },
  ],
};

describe('granular RBAC: content grants', () => {
  it('an exact content-type grant wins over the wildcard', () => {
    expect(grantFor(editor, 'post')?.actions).toEqual(['read', 'write']);
    expect(grantFor(editor, 'page')?.actions).toEqual(['read']);
  });

  it('unrestricted principals pass every content check', () => {
    expect(canAccessContentType(unrestricted, 'publish', 'anything')).toBe(true);
    expect(() => authorizeContent(unrestricted, 'write', 'anything')).not.toThrow();
    expect(() => assertWritableFields(unrestricted, 'post', { internalNotes: {} })).not.toThrow();
  });

  it('denies ungranted actions and types', () => {
    expect(canAccessContentType(editor, 'publish', 'post')).toBe(false);
    expect(canAccessContentType(editor, 'write', 'page')).toBe(false);
    expect(() => authorizeContent(editor, 'publish', 'post')).toThrow(/content:publish:post/);
  });

  it('masks denied fields on read but keeps the rest', () => {
    const fields = { title: { 'en-US': 'T' }, internalNotes: { 'en-US': 'secret' } };
    const masked = maskDeniedFields(editor, 'post', fields);
    expect(Object.keys(masked)).toEqual(['title']);
    // Another type without field rules is untouched.
    expect(maskDeniedFields(editor, 'page', fields)).toEqual(fields);
  });

  it('rejects writes to denied and read-only fields', () => {
    expect(() => assertWritableFields(editor, 'post', { title: {} })).not.toThrow();
    expect(() => assertWritableFields(editor, 'post', { internalNotes: {} })).toThrow(
      /internalNotes/,
    );
    expect(() => assertWritableFields(editor, 'post', { slug: {} })).toThrow(/slug/);
  });

  it('coarse authorize is unchanged by grants', () => {
    expect(() => authorize(editor, SCOPES.contentWrite, 's1')).not.toThrow();
    expect(() => authorize(editor, SCOPES.spaceAdmin, 's1')).toThrow();
  });
});
