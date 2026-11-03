import { renderToStaticMarkup as html } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { SignInPage } from './SignIn';

// Rendered outside a SessionProvider: no administrator, English.
const page = () => html(<MemoryRouter><SignInPage /></MemoryRouter>);

describe('the sign-in page', () => {
  it('sends someone who forgot their password to the ProxiaPay team, since no reset link exists yet', () => {
    expect(page()).toContain('Forgot your password? Contact the ProxiaPay team.');
  });

  it('promises no reset link it cannot send', () => {
    expect(page()).not.toContain('Request a password reset');
    expect(page()).not.toContain('a link is on its way');
  });
});
