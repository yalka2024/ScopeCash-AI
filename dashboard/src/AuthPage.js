import React, { useState, useEffect } from 'react';
import { login, register } from './api';
import { Card, CardContent } from './components/ui/card';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';

export default function AuthPage({ isBeta }) {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);

  useEffect(() => {
    const API = process.env.REACT_APP_API_URL || '/api';
    fetch(API + '/setup/status', { credentials: 'include' })
      .then((r) => r.json())
      .then((d) => { if (d && d.requiresSetup) setNeedsSetup(true); })
      .catch(() => {});
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (isLogin) {
        await login(email, password);
      } else {
        await register(email, password, name);
      }
      window.location.reload();
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md">
        <CardContent className="p-8">
          <h1 className="mb-1 text-center text-2xl font-bold text-primary">ScopeCash AI</h1>
          <p className="mb-6 text-center text-sm text-muted-foreground">AI-operated SaaS platform that helps small specialty contractors document cha...</p>

          {isBeta && (
            <div className="mb-4 rounded-md bg-accent p-2 text-center text-xs text-accent-foreground">
              🔒 Private Beta — Authorized access only
            </div>
          )}

          {needsSetup && (
            <div className="mb-4 rounded-md border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-300">
              This instance hasn’t been configured yet.{' '}
              <a
                href="#setup"
                onClick={(e) => { e.preventDefault(); window.location.hash = '#setup'; window.location.reload(); }}
                className="font-semibold underline"
              >
                Run the setup wizard →
              </a>
            </div>
          )}

          {error && (
            <div role="alert" aria-live="assertive" className="mb-4 rounded-md border border-red-500/40 bg-red-500/10 p-2 text-sm text-red-300">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} aria-label={isLogin ? 'Sign in form' : 'Create account form'} className="space-y-4">
            {!isLogin && !isBeta && (
              <Input type="text" placeholder="Full Name" aria-label="Full name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
            )}
            <Input type="email" placeholder="Email" aria-label="Email address" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <Input type="password" placeholder="Password" aria-label="Password" autoComplete={isLogin ? 'current-password' : 'new-password'} value={password} onChange={(e) => setPassword(e.target.value)} required />
            <Button type="submit" disabled={loading} aria-busy={loading} className="w-full">
              {loading ? 'Please wait...' : (isLogin ? 'Sign In' : 'Create Account')}
            </Button>
          </form>

          {!isBeta && (
            <p className="mt-4 cursor-pointer text-center text-sm text-muted-foreground hover:text-foreground" onClick={() => setIsLogin(!isLogin)}>
              {isLogin ? "Don't have an account? Register" : 'Already have an account? Sign In'}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

