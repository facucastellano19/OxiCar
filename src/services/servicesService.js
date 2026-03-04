const getConnection = require("../database/mysql");
const auditLogService = require("./auditLogService");

class ServicesService {
  async getServices(params = {}) {
    let connection;
    try {
      connection = await getConnection();
      const { name, category, status = "active" } = params;
      let baseQuery = `
                SELECT
                    s.id,
                    s.name,
                    s.price,
                    s.category_id,
                    sc.name AS category
                FROM services s
                JOIN service_categories sc ON s.category_id = sc.id
            `;
      const whereConditions = [];
      const queryParams = [];

      if (status === "active") {
        whereConditions.push("s.deleted_at IS NULL");
      } else if (status === "inactive") {
        whereConditions.push("s.deleted_at IS NOT NULL");
      }

      if (name) {
        whereConditions.push(`s.name LIKE ?`);
        queryParams.push(`%${name}%`);
      }

      if (category) {
        whereConditions.push(`sc.name LIKE ?`);
        queryParams.push(`%${category}%`);
      }

      if (whereConditions.length > 0) {
        baseQuery += " WHERE " + whereConditions.join(" AND ");
      }

      baseQuery += ` ORDER BY s.name`;

      const [services] = await connection.query(baseQuery, queryParams);
      return {
        message: "Services retrieved successfully",
        data: services,
      };
    } finally {
      if (connection) connection.release();
    }
  }

  async getServiceById(id) {
    let connection;
    try {
      connection = await getConnection();
      const query = `
                SELECT 
                    s.id, 
                    s.category_id,
                    s.name, 
                    s.price, 
                    sc.name AS category_name
                FROM services s
                JOIN service_categories sc ON s.category_id = sc.id
                WHERE s.deleted_at IS NULL AND s.id = ?
            `;

      const [services] = await connection.query(query, [id]);
      const service = services[0];

      if (!service) {
        const error = new Error("Service not found");
        error.status = 404;
        throw error;
      }

      return {
        message: "Service retrieved successfully",
        data: service,
      };
    } finally {
      if (connection) connection.release();
    }
  }

  async getCategories(params = {}) {
    let connection;
    try {
      connection = await getConnection();
      const { status = "active" } = params;
      let query = `
                SELECT id, name
                FROM service_categories
            `;
      if (status === "active") query += " WHERE deleted_at IS NULL";
      else if (status === "inactive") query += " WHERE deleted_at IS NOT NULL";

      query += " ORDER BY name";
      const [categories] = await connection.query(query);
      return {
        message: "Service categories retrieved successfully",
        data: categories,
      };
    } finally {
      if (connection) connection.release();
    }
  }

  async postService(data) {
    let connection;
    try {
      connection = await getConnection();
      await connection.beginTransaction();

      // 1. Check if a service with this name exists (active or soft-deleted)
      const [existingService] = await connection.query(
        `SELECT * FROM services WHERE name = ?`,
        [data.name],
      );

      if (existingService.length > 0) {
        const service = existingService[0];
        if (service.deleted_at === null) {
          // 2. Service is active, throw conflict error
          const error = new Error("Service with this name already exists");
          error.status = 409;
          throw error;
        } else {
          // 2a. Service is soft-deleted, so we "undelete" and update it
          await connection.query(
            `UPDATE services SET 
                            category_id = ?, price = ?, 
                            deleted_at = NULL, deleted_by = NULL, 
                            updated_at = NOW(), updated_by = ? 
                         WHERE id = ?`,
            [data.category_id, data.price, data.created_by, service.id],
          );
          await connection.commit();

          // Get the full new state for auditing
          const [restoredServiceRows] = await connection.query(
            `SELECT * FROM services WHERE id = ?`,
            [service.id],
          );

          // Audit Log for RESTORE (as UPDATE)
          await auditLogService.log({
            userId: data.created_by,
            username: data.usernameToken,
            actionType: "UPDATE",
            entityType: "service",
            entityId: service.id,
            changes: { oldValue: service, newValue: restoredServiceRows[0] },
            ipAddress: data.ipAddress,
          });

          return {
            message: "Service restored successfully",
            data: restoredServiceRows[0],
          };
        }
      }

      // 3. Service does not exist, create a new one
      const [result] = await connection.query(
        `INSERT INTO services 
                 (category_id, name, price, created_by, created_at)
                 VALUES (?, ?, ?, ?, NOW())`,
        [data.category_id, data.name, data.price, data.created_by],
      );

      await connection.commit();

      // Get the full new state of the service for auditing
      const [newServiceDataResult] = await connection.query(
        `SELECT * FROM services WHERE id = ?`,
        [result.insertId],
      );
      const newServiceData = newServiceDataResult[0];

      // Audit Log
      await auditLogService.log({
        userId: data.created_by,
        username: data.usernameToken,
        actionType: "CREATE",
        entityType: "service",
        entityId: result.insertId,
        ipAddress: data.ipAddress,
        changes: { newValue: newServiceData },
      });

      return {
        message: "Service created successfully",
        data: { id: result.insertId, ...data },
      };
    } catch (err) {
      await connection.rollback();
      // Audit Log for failure
      await auditLogService.log({
        userId: data.created_by,
        username: data.usernameToken,
        actionType: "CREATE",
        entityType: "service",
        ipAddress: data.ipAddress,
        status: "FAILURE",
        errorMessage: err.message,
      });
      throw err;
    } finally {
      if (connection) connection.release();
    }
  }

  async postCategory(data) {
    let connection;
    try {
      connection = await getConnection();
      await connection.beginTransaction();

      // 1. Check if a category with this name exists (active or soft-deleted)
      const [existingCategory] = await connection.query(
        `SELECT * FROM service_categories WHERE name = ?`,
        [data.name],
      );

      if (existingCategory.length > 0) {
        const category = existingCategory[0];
        if (category.deleted_at === null) {
          // 2. Category is active, throw conflict error
          const error = new Error("Category with this name already exists");
          error.status = 409;
          throw error;
        } else {
          // 2a. Category is soft-deleted, so we "undelete" it
          await connection.query(
            `UPDATE service_categories 
                         SET deleted_at = NULL, deleted_by = NULL, updated_at = NOW(), updated_by = ? 
                         WHERE id = ?`,
            [data.created_by, category.id],
          );
          await connection.commit();

          // Get the full new state of the category for auditing
          const [newCategoryDataResult] = await connection.query(
            `SELECT * FROM service_categories WHERE id = ?`,
            [category.id],
          );
          const newCategoryData = newCategoryDataResult[0];

          // Audit Log for RESTORE (as UPDATE)
          await auditLogService.log({
            userId: data.created_by,
            username: data.usernameToken,
            actionType: "UPDATE",
            entityType: "service_category",
            entityId: category.id,
            changes: { oldValue: category, newValue: newCategoryData },
            ipAddress: data.ipAddress,
          });
          return {
            message: "Category restored successfully",
            data: { id: category.id, ...data },
          };
        }
      }

      // 2b. Category does not exist, create a new one
      const [insertResult] = await connection.query(
        `INSERT INTO service_categories (name, created_at, created_by)
                 VALUES (?, NOW(), ?)`,
        [data.name, data.created_by],
      );

      await connection.commit();

      // Get the full new state of the category for auditing
      const [newCategoryDataResult] = await connection.query(
        `SELECT * FROM service_categories WHERE id = ?`,
        [insertResult.insertId],
      );
      const newCategoryData = newCategoryDataResult[0];

      // Audit Log for CREATE
      await auditLogService.log({
        userId: data.created_by,
        username: data.usernameToken,
        actionType: "CREATE",
        entityType: "service_category",
        entityId: insertResult.insertId,
        ipAddress: data.ipAddress,
        changes: { newValue: newCategoryData },
      });
      return {
        message: "Category created successfully",
        data: { id: insertResult.insertId, ...data },
      };
    } catch (err) {
      await connection.rollback();
      // Audit Log for failure
      await auditLogService.log({
        userId: data.created_by,
        username: data.usernameToken,
        actionType: "CREATE",
        entityType: "service_category",
        ipAddress: data.ipAddress,
        status: "FAILURE",
        errorMessage: err.message,
      });
      throw err;
    } finally {
      if (connection) connection.release();
    }
  }

  async putCategory(id, data) {
    let connection;
    let oldCategoryData = null;
    try {
      connection = await getConnection();
      await connection.beginTransaction();

      const [existingCategory] = await connection.query(
        `SELECT * FROM service_categories WHERE id = ? AND deleted_at IS NULL`,
        [id],
      );
      if (existingCategory.length === 0) {
        const error = new Error("Category not found");
        error.status = 404;
        throw error;
      }
      oldCategoryData = existingCategory[0];

      const [conflictCategory] = await connection.query(
        `SELECT id FROM service_categories WHERE name = ? AND id != ? AND deleted_at IS NULL`,
        [data.name, id],
      );
      if (conflictCategory.length > 0) {
        const error = new Error(
          "Another category with this name already exists.",
        );
        error.status = 409;
        throw error;
      }

      await connection.query(
        `UPDATE service_categories SET name = ?, updated_at = NOW(), updated_by = ? WHERE id = ?`,
        [data.name, data.updated_by, id],
      );

      await connection.commit();

      // Get the full new state of the category for auditing
      const [newCategoryDataResult] = await connection.query(
        `SELECT * FROM service_categories WHERE id = ?`,
        [id],
      );
      const newCategoryData = newCategoryDataResult[0];

      // Audit Log for success
      await auditLogService.log({
        userId: data.updated_by,
        username: data.usernameToken,
        actionType: "UPDATE",
        entityType: "service_category",
        entityId: id,
        changes: { oldValue: oldCategoryData, newValue: newCategoryData },
        ipAddress: data.ipAddress,
      });
      return {
        message: "Category updated successfully",
        data: { id, ...data },
      };
    } catch (error) {
      await connection.rollback();
      // Audit Log for failure
      await auditLogService.log({
        userId: data.updated_by,
        username: data.usernameToken,
        actionType: "UPDATE",
        entityType: "service_category",
        entityId: id,
        ipAddress: data.ipAddress,
        status: "FAILURE",
        errorMessage: error.message,
      });
      throw error;
    } finally {
      if (connection) connection.release();
    }
  }

  async deleteCategory(id, data) {
    let connection;
    let oldCategoryData = null;
    try {
      connection = await getConnection();
      await connection.beginTransaction();

      const [existingCategory] = await connection.query(
        `SELECT * FROM service_categories WHERE id = ? AND deleted_at IS NULL`,
        [id],
      );
      oldCategoryData = existingCategory[0];
      if (existingCategory.length === 0) {
        const error = new Error("Category not found");
        error.status = 404;
        throw error;
      }

      const [servicesUsingCategory] = await connection.query(
        `SELECT id FROM services WHERE category_id = ? AND deleted_at IS NULL`,
        [id],
      );
      if (servicesUsingCategory.length > 0) {
        const error = new Error(
          "Cannot delete category because it is being used by one or more services.",
        );
        error.status = 409;
        throw error;
      }

      await connection.query(
        `UPDATE service_categories SET deleted_at = NOW(), deleted_by = ? WHERE id = ?`,
        [data.deleted_by, id],
      );

      await connection.commit();

      const deletedCategoryState = {
        ...oldCategoryData,
        deleted_at: new Date(),
      };

      // Audit Log for success
      await auditLogService.log({
        userId: data.deleted_by,
        username: data.usernameToken,
        actionType: "DELETE",
        entityType: "service_category",
        entityId: id,
        ipAddress: data.ipAddress,
        changes: {
          oldValue: oldCategoryData,
          newValue: deletedCategoryState, // <-- AGREGAR ESTO
        },
      });
      return { message: "Category deleted successfully" };
    } catch (error) {
      await connection.rollback();
      // Audit Log for failure
      await auditLogService.log({
        userId: data.deleted_by,
        username: data.usernameToken,
        actionType: "DELETE",
        entityType: "service_category",
        entityId: id,
        ipAddress: data.ipAddress,
        status: "FAILURE",
        errorMessage: error.message,
      });
      throw error;
    } finally {
      if (connection) connection.release();
    }
  }

  async putService(id, data) {
    let connection;
    let oldServiceData = null;
    try {
      connection = await getConnection();
      await connection.beginTransaction();

      const [existingService] = await connection.query(
        `SELECT * FROM services WHERE id = ? AND deleted_at IS NULL`,
        [id],
      );

      if (!existingService[0]) {
        const error = new Error("Service not found");
        error.status = 404;
        throw error;
      }

      const service = existingService[0];
      oldServiceData = existingService[0];

      const [conflictService] = await connection.query(
        `SELECT id FROM services WHERE name = ? AND id != ? AND deleted_at IS NULL`,
        [data.name ?? service.name, id],
      );

      if (conflictService.length > 0) {
        const error = new Error("Service with this name already exists");
        error.status = 409;
        throw error;
      }

      const [result] = await connection.query(
        `UPDATE services SET 
                 category_id = ?, 
                 name = ?, 
                 price = ?, 
                 updated_by = ?, 
                 updated_at = NOW()
                 WHERE id = ? AND deleted_at IS NULL`,
        [
          data.category_id ?? service.category_id,
          data.name ?? service.name,
          data.price ?? service.price,
          data.updated_by,
          id,
        ],
      );

      if (result.affectedRows === 0) {
        const error = new Error("Error while updating service");
        error.status = 500;
        throw error;
      }

      await connection.commit();

      // Get the full new state of the service for auditing
      const [newServiceDataResult] = await connection.query(
        `SELECT * FROM services WHERE id = ?`,
        [id],
      );
      const newServiceData = newServiceDataResult[0];

      // Audit Log for success
      await auditLogService.log({
        userId: data.updated_by,
        username: data.usernameToken,
        actionType: "UPDATE",
        entityType: "service",
        entityId: id,
        changes: { oldValue: oldServiceData, newValue: newServiceData },
        ipAddress: data.ipAddress,
      });

      return {
        message: "Service updated successfully",
        data: { id, ...data },
      };
    } catch (err) {
      await connection.rollback();
      // Audit Log for failure
      await auditLogService.log({
        userId: data.updated_by,
        username: data.usernameToken,
        actionType: "UPDATE",
        entityType: "service",
        entityId: id,
        ipAddress: data.ipAddress,
        status: "FAILURE",
        errorMessage: err.message,
      });
      throw err;
    } finally {
      if (connection) connection.release();
    }
  }

  async deleteService(id, data) {
    let connection;
    let oldServiceData = null;
    try {
      connection = await getConnection();
      await connection.beginTransaction();

      const [existingService] = await connection.query(
        `SELECT * FROM services WHERE id = ? AND deleted_at IS NULL`,
        [id],
      );

      oldServiceData = existingService[0];
      if (!existingService[0]) {
        const error = new Error("Service not found");
        error.status = 404;
        throw error;
      }

      const [result] = await connection.query(
        `UPDATE services SET deleted_at = NOW(), deleted_by = ? WHERE id = ? AND deleted_at IS NULL`,
        [data.deleted_by, id],
      );

      if (result.affectedRows === 0) {
        const error = new Error("Error while deleting service");
        error.status = 500;
        throw error;
      }

      await connection.commit();
      const deletedState = { ...oldServiceData, deleted_at: new Date() };

      // Audit Log for success
      await auditLogService.log({
        userId: data.deleted_by,
        username: data.usernameToken,
        actionType: "DELETE",
        entityType: "service",
        entityId: id,
        ipAddress: data.ipAddress,
        changes: {
          oldValue: oldServiceData,
          newValue: deletedState,
        },
      });

      return {
        id,
        message: "Service deleted successfully",
        deleted_by: data.deleted_by,
      };
    } catch (err) {
      await connection.rollback();
      // Audit Log for failure
      await auditLogService.log({
        userId: data.deleted_by,
        username: data.usernameToken,
        actionType: "DELETE",
        entityType: "service",
        entityId: id,
        ipAddress: data.ipAddress,
        status: "FAILURE",
        errorMessage: err.message,
      });
      throw err;
    } finally {
      if (connection) connection.release();
    }
  }

  async restoreService(id, data) {
    let connection;
    let oldServiceData = null;
    try {
      connection = await getConnection();
      await connection.beginTransaction();

      // 1. Find the soft-deleted service
      const [services] = await connection.query(
        `SELECT * FROM services WHERE id = ? AND deleted_at IS NOT NULL`,
        [id],
      );

      if (!services[0]) {
        const error = new Error(
          "Inactive service not found or is already active.",
        );
        error.status = 404;
        throw error;
      }
      oldServiceData = services[0];

      // 2. Restore the service
      await connection.query(
        `UPDATE services SET deleted_at = NULL, deleted_by = NULL, updated_at = NOW(), updated_by = ? WHERE id = ?`,
        [data.updated_by, id],
      );

      await connection.commit();

      // 3. Get the new state for auditing
      const [newServiceDataResult] = await connection.query(
        `SELECT * FROM services WHERE id = ?`,
        [id],
      );
      const newServiceData = newServiceDataResult[0];

      // 4. Audit the restoration
      await auditLogService.log({
        userId: data.updated_by,
        username: data.usernameToken,
        actionType: "RESTORE",
        entityType: "service",
        entityId: id,
        ipAddress: data.ipAddress,
        changes: {
          oldValue: oldServiceData,
          newValue: { ...newServiceData, deleted_at: null },
        },
      });

      return {
        message: "Service restored successfully",
        data: { id: newServiceData.id, name: newServiceData.name },
      };
    } catch (error) {
      if (connection) await connection.rollback();
      // Audit log for failure is omitted here as it would be complex to log without old data
      // and the primary failure case is a 404, which is self-explanatory.
      throw error;
    } finally {
      if (connection) connection.release();
    }
  }

  async restoreCategory(id, data) {
    let connection;
    let oldCategoryData = null;
    try {
      connection = await getConnection();
      await connection.beginTransaction();

      // 1. Find the soft-deleted category
      const [categories] = await connection.query(
        `SELECT * FROM service_categories WHERE id = ? AND deleted_at IS NOT NULL`,
        [id],
      );

      if (!categories[0]) {
        const error = new Error(
          "Inactive service category not found or is already active.",
        );
        error.status = 404;
        throw error;
      }
      oldCategoryData = categories[0];

      // 2. Restore the category
      await connection.query(
        `UPDATE service_categories SET deleted_at = NULL, deleted_by = NULL, updated_at = NOW(), updated_by = ? WHERE id = ?`,
        [data.updated_by, id],
      );

      await connection.commit();

      // 3. Get the new state for auditing
      const [newCategoryDataResult] = await connection.query(
        `SELECT * FROM service_categories WHERE id = ?`,
        [id],
      );
      const newCategoryData = newCategoryDataResult[0];

      // 4. Audit the restoration
      await auditLogService.log({
        userId: data.updated_by,
        username: data.usernameToken,
        actionType: "RESTORE",
        entityType: "service_category",
        entityId: id,
        ipAddress: data.ipAddress,
        changes: {
          oldValue: oldCategoryData,
          newValue: { ...newCategoryData, deleted_at: null },
        },
      });

      return {
        message: "Service category restored successfully",
        data: { id: newCategoryData.id, name: newCategoryData.name },
      };
    } catch (error) {
      if (connection) await connection.rollback();
      // Audit log for failure is omitted here as it would be complex to log without old data
      // and the primary failure case is a 404, which is self-explanatory.
      throw error;
    } finally {
      if (connection) connection.release();
    }
  }

  async getCategoryById(id) {
    let connection;
    try {
      connection = await getConnection();
      const query = `
                SELECT id, name 
                FROM service_categories 
                WHERE deleted_at IS NULL AND id = ?
            `;
      const [categoryResult] = await connection.query(query, [id]);
      const category = categoryResult[0];

      if (!category) {
        const error = new Error("Category not found");
        error.status = 404;
        throw error;
      }

      return { message: "Category retrieved successfully", data: category };
    } finally {
      if (connection) connection.release();
    }
  }
}

module.exports = ServicesService;
