export function requireToken(expectedToken) {
  return (request, response, next) => {
    if (!expectedToken) {
      response.status(500).json({ message: 'BRIDGE_TOKEN is not configured.' });
      return;
    }

    const header = request.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';

    if (token !== expectedToken) {
      response.status(401).json({ message: 'Unauthorized.' });
      return;
    }

    next();
  };
}
