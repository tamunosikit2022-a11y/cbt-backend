const router = require('express').Router();
const { requireStudent, requireAdmin } = require('../middleware/auth');
const ctrl = require('../controllers/cutoffController');

// Students (and anyone logged in) can search/browse
router.get('/', requireStudent, ctrl.listCutoffs);
router.get('/institutions', requireStudent, ctrl.listInstitutions);

// Only admins can add/edit/remove entries — keeps the dataset trustworthy
router.post('/',      requireAdmin, ctrl.createCutoff);
router.patch('/:id',  requireAdmin, ctrl.updateCutoff);
router.delete('/:id', requireAdmin, ctrl.deleteCutoff);

module.exports = router;
