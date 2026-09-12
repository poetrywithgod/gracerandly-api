require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

const errandsRouter = require("./routes/errands");
const usersRouter = require("./routes/users");
const paymentsRouter = require("./routes/payments");
const authRouter = require("./routes/auth");
const adminRouter = require("./routes/admin");

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "gracerandly-api", time: new Date().toISOString() });
});

app.use("/errands", errandsRouter);
app.use("/users", usersRouter);
app.use("/payments", paymentsRouter);
app.use("/auth", authRouter);
app.use("/admin", adminRouter);

// TODO as this grows:
//   app.use("/trust-safety", require("./routes/trustSafety"));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Gracerandly API listening on http://localhost:${PORT}`);
});
