const { param, query } = require('express-validator');

const objectId = (name, location = param) =>
  location(name).isMongoId().withMessage(`${name} must be a valid id`);

const pagination = [
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be 1 or greater').toInt(),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100').toInt(),
  /*
   * `offset` is the "load more" form of the same cursor. A homepage rail that has
   * already shown 10 rows asks for the next 15, which is not a page boundary of any
   * page size; where it is sent it takes precedence over `page`.
   */
  query('offset').optional().isInt({ min: 0 }).withMessage('Offset must be 0 or greater').toInt(),
];

module.exports = { objectId, pagination };
