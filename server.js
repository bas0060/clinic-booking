import app from "./src/app.js";

const port = process.env.PORT || 9000;
app.listen(port, () => console.log(`Clinic booking API listening on ${port}`));
