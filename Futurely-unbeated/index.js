// ... lines 35-59 ...
function getCorsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = env.CORS_ORIGIN || 'https://futurely.unbeated.com';
  
  // More robust origin check
  const isAllowed = origin === allowed || 
                    origin.includes('unbeated.com') || 
                    origin.includes('localhost') || 
                    origin.includes('127.0.0.1');

  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : allowed,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function applyCors(response, request, env) {
  const newResponse = new Response(response.body, response);
  const cors = getCorsHeaders(request, env);
  Object.entries(cors).forEach(([k, v]) => newResponse.headers.set(k, v));
  return newResponse;
}
