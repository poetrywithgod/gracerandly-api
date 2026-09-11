require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

const errandsRouter = require("./routes/errands");
const usersRouter = require("./routes/users");

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "gracerandly-api", time: new Date().toISOString() });
});

app.use("/errands", errandsRouter);
app.use("/users", usersRouter);

// TODO as this grows:
//   app.use("/trust-safety", require("./routes/trustSafety"));
//   app.use("/payments", require("./routes/payments"));
//   app.use("/admin", require("./routes/admin"));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Gracerandly API listening on http://localhost:${PORT}`);
});
