/**
 * Futurely — Frontend Auth & API Utility
 */

const API_BASE = 'https://api.futurely.unbeated.com/api';

const Auth = {
  // --- Session Management ---
  getUserId() {
    return localStorage.getItem('futurely_user_id');
  },

  setUserId(id) {
    if (id) localStorage.setItem('futurely_user_id', id);
    else localStorage.removeItem('futurely_user_id');
  },

  isLoggedIn() {
    return !!this.getUserId();
  },

  getHeaders() {
    const id = this.getUserId();
    return {
      'Content-Type': 'application/json',
      'Authorization': id ? `Bearer ${id}` : ''
    };
  },

  // --- API Methods ---
  async requestPin(email) {
    const res = await fetch(`${API_BASE}/auth/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    return res.json();
  },

  async verifyPin(email, code) {
    const res = await fetch(`${API_BASE}/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code })
    });
    const data = await res.json();
    if (data.success && data.userId) {
      this.setUserId(data.userId);
    }
    return data;
  },

  async logout() {
    this.setUserId(null);
    window.location.href = 'index.html';
  },

  // --- Data Fetching ---
  async apiFetch(endpoint, options = {}) {
    if (!this.isLoggedIn()) {
      // Redirect to login if needed, or return error
      console.warn('Not logged in. Redirecting...');
      return { success: false, error: 'Unauthorized' };
    }

    const res = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      headers: {
        ...this.getHeaders(),
        ...(options.headers || {})
      }
    });
    
    if (res.status === 401) {
      this.logout();
    }
    
    return res.json();
  }
};

window.FuturelyAuth = Auth;
