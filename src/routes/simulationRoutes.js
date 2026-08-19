const router = require("express").Router();
const { requireStudent } = require("../middleware/auth");
const { compileLimiter } = require("../middleware/rateLimit");
const ctrl = require("../controllers/simulationController");
const compileCtrl = require("../controllers/compileController");

router.use(requireStudent);

router.get("/projects",      ctrl.listProjects);
router.get("/projects/:id",  ctrl.getProject);
router.post("/projects",     ctrl.createProject);
router.put("/projects/:id",  ctrl.updateProject);
router.delete("/projects/:id", ctrl.deleteProject);

// Phase 2 (Arduino): compile-only endpoint, see compileController.js header
// for why this is the one exception to "no server-side execution."
router.post("/compile", compileLimiter, compileCtrl.compile);

module.exports = router;
