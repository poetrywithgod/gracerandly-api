const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error("Missing JWT_SECRET in .env — auth will fail on every request until this is set.");
}

/**
 * Verifies the Bearer token on the request and attaches { id, role } to
 * req.user. Every route that moves money, changes errand state, or
 * touches another user's data should sit behind this.
 */
function authenticate(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Missing Authorization header (expected: Bearer <token>)" });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { id: payload.sub, role: payload.role };
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

/**
 * Restricts a route to one or more roles. Use AFTER authenticate.
 * e.g. router.post("/", authenticate, requireRole("requester"), handler)
 */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: `This action requires role: ${allowedRoles.join(" or ")}` });
    }
    next();
  };
}

function signToken({ id, role }) {
  return jwt.sign({ sub: id, role }, JWT_SECRET, { expiresIn: "30d" });
}

module.exports = { authenticate, requireRole, signToken };
