import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import Dashboard from './components/Dashboard';
import URLGroupsPage from './components/URLGroupsPage';
import GSCScraperPage from './components/GSCScraperPage';

const BACKEND = '/api';

export default function App() {
  const [auth, setAuth] = useState(null); // { access_token, email, name, picture }
  const [error, setError] = useState('');
  const [page, setPage] = useState('dashboard'); // 'dashboard' | 'url-groups' | 'gsc-scraper'
  const authRef = useRef(auth);

  // Keep ref in sync so the interceptor always sees the latest auth without re-registering
  useEffect(() => { authRef.current = auth; }, [auth]);

  // Global axios interceptor — silently refreshes expired access_token and retries the request
  useEffect(() => {
    const id = axios.interceptors.response.use(
      res => res,
      async err => {
        const original = err.config;
        const isCredErr = err.response?.status === 401
          || err.response?.data?.error?.includes('Invalid Credentials');
        if (isCredErr && !original._retry && authRef.current?.refresh_token) {
          original._retry = true;
          try {
            const { data } = await axios.post(`${BACKEND}/auth/refresh`, {
              refresh_token: authRef.current.refresh_token,
            });
            const newAuth = { ...authRef.current, access_token: data.access_token };
            setAuth(newAuth);
            sessionStorage.setItem('cwv_auth', JSON.stringify(newAuth));
            original.headers['x-access-token'] = data.access_token;
            return axios(original);
          } catch {
            sessionStorage.removeItem('cwv_auth');
            setAuth(null);
          }
        }
        return Promise.reject(err);
      }
    );
    return () => axios.interceptors.response.eject(id);
  }, []); // register once

  // Parse tokens from URL after OAuth redirect
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const accessToken = params.get('access_token');
    const authError = params.get('error');

    if (authError) {
      setError('Authentication failed. Please try again.');
      window.history.replaceState({}, '', window.location.pathname);
      return;
    }

    if (accessToken) {
      const authData = {
        access_token: accessToken,
        refresh_token: params.get('refresh_token') || '',
        email: params.get('email') || '',
        name: params.get('name') || '',
        picture: params.get('picture') || '',
      };
      setAuth(authData);
      sessionStorage.setItem('cwv_auth', JSON.stringify(authData));
      window.history.replaceState({}, '', window.location.pathname);
      return;
    }

    // Restore from session storage
    const stored = sessionStorage.getItem('cwv_auth');
    if (stored) {
      try { setAuth(JSON.parse(stored)); } catch { sessionStorage.removeItem('cwv_auth'); }
    }
  }, []);

  const handleLogin = () => {
    window.location.href = `${BACKEND}/auth/google`;
  };

  const handleLogout = () => {
    sessionStorage.removeItem('cwv_auth');
    setAuth(null);
  };

  if (!auth) {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="login-logo">
            <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
              <rect width="48" height="48" rx="12" fill="#4285F4" />
              <text x="8" y="34" fontSize="24" fontWeight="bold" fill="white">CWV</text>
            </svg>
          </div>
          <h1>Core Web Vitals Dashboard</h1>
          <p>Connect your Google Search Console account to analyze CWV performance grouped by status.</p>
          {error && <div className="error-banner">{error}</div>}
          <button className="btn-google" onClick={handleLogin}>
            <GoogleIcon />
            Sign in with Google
          </button>
          <p className="login-note">Requires Search Console read access</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <nav className="tab-nav">
        <button className={`tab-btn ${page === 'dashboard' ? 'active' : ''}`} onClick={() => setPage('dashboard')}>
          URL Performance
        </button>
        <button className={`tab-btn ${page === 'url-groups' ? 'active' : ''}`} onClick={() => setPage('url-groups')}>
          URL Groups
        </button>
        <button className={`tab-btn ${page === 'gsc-scraper' ? 'active' : ''}`} onClick={() => setPage('gsc-scraper')}>
          GSC Scraper
        </button>
      </nav>
      {page === 'dashboard' && <Dashboard auth={auth} onLogout={handleLogout} />}
      {page === 'url-groups' && <URLGroupsPage auth={auth} onLogout={handleLogout} />}
      {page === 'gsc-scraper' && <GSCScraperPage auth={auth} onLogout={handleLogout} />}
    </>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z" fill="#4285F4" />
      <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" fill="#34A853" />
      <path d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05" />
      <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335" />
    </svg>
  );
}
