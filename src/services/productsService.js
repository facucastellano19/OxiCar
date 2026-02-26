const getConnection = require("../database/mysql");
const auditLogService = require("./auditLogService");

class ProductsService {
  #calculateLowStock(product) {
    return product.stock <= product.min_stock;
  }

  async getProducts(params) {
    let connection;
    try {
      connection = await getConnection();
      const { name, category_id, status = "active" } = params;

      let query = `
                SELECT p.id, p.name, p.price, p.stock, p.min_stock, pc.name as category, p.category_id
                FROM products p
                INNER JOIN product_categories pc ON p.category_id = pc.id
            `;
      const queryParams = [];
      const whereConditions = [];

      if (status === "active") {
        whereConditions.push("p.deleted_at IS NULL");
      } else if (status === "inactive") {
        whereConditions.push("p.deleted_at IS NOT NULL");
      }

      if (category_id) {
        whereConditions.push(`p.category_id = ?`);
        queryParams.push(category_id);
      }

      if (params.name) {
        whereConditions.push(`p.name LIKE ?`);
        queryParams.push(`%${params.name}%`);
      }

      if (whereConditions.length > 0) {
        query += " WHERE " + whereConditions.join(" AND ");
      }

      query += ` ORDER BY p.name`;

      const [products] = await connection.query(query, queryParams);

      // Map products to include lowStock property using private method
      const productsWithStockStatus = products.map((p) => ({
        ...p,
        lowStock: this.#calculateLowStock(p),
      }));

      return {
        message: "Products retrieved successfully",
        data: productsWithStockStatus,
      };
    } finally {
      if (connection) connection.release();
    }
  }

  // Get a single product by ID with category and low stock status
  async getProductById(id) {
    let connection;
    try {
      connection = await getConnection();
      const query = `
                SELECT p.id, p.name, p.price, p.stock, p.min_stock, pc.name as category
                FROM products p
                INNER JOIN product_categories pc ON p.category_id = pc.id
                WHERE p.deleted_at IS NULL AND p.id = ?
            `;
      const [productQueryResult] = await connection.query(query, [id]);
      const product = productQueryResult[0];

      if (!product) {
        const error = new Error("Product not found");
        error.status = 404;
        throw error;
      }

      const productWithStockStatus = {
        ...product,
        lowStock: this.#calculateLowStock(product),
      };

      return {
        message: "Product retrieved successfully",
        data: productWithStockStatus,
      };
    } finally {
      if (connection) connection.release();
    }
  }

  async postProduct(data) {
    let connection;
    try {
      connection = await getConnection();
      await connection.beginTransaction();

      // 1. Check if a product with this name exists (active or soft-deleted)
      const [existingProducts] = await connection.query(
        `SELECT * FROM products WHERE name = ?`,
        [data.name],
      );
      if (existingProducts.length > 0) {
        const product = existingProducts[0];
        if (product.deleted_at === null) {
          // 2. Product is active, throw conflict error
          const error = new Error("Product with this name already exists");
          error.status = 409;
          throw error;
        } else {
          // 2a. Product is soft-deleted, so we "undelete" and update it
          await connection.query(
            `UPDATE products SET 
                            price = ?, stock = ?, min_stock = ?, category_id = ?,
                            deleted_at = NULL, deleted_by = NULL, 
                            updated_at = NOW(), updated_by = ? 
                         WHERE id = ?`,
            [
              data.price,
              data.stock,
              data.min_stock,
              data.category_id,
              data.created_by,
              product.id,
            ],
          );
          await connection.commit();

          // Get the full new state for auditing
          const [restoredProductRows] = await connection.query(
            `SELECT * FROM products WHERE id = ?`,
            [product.id],
          );

          // Audit Log for RESTORE (as UPDATE)
          await auditLogService.log({
            userId: data.created_by,
            username: data.usernameToken,
            actionType: "UPDATE",
            entityType: "product",
            entityId: product.id,
            ipAddress: data.ipAddress,
            changes: {
              oldValue: product,
              newValue: { ...restoredProductRows[0], deleted_at: null },
            },
          });

          return {
            message: "Product restored successfully",
            data: restoredProductRows[0],
          };
        }
      }

      // 3. Product does not exist, create a new one
      // First, check if category exists
      const [existingCategories] = await connection.query(
        `SELECT id FROM product_categories WHERE id = ? AND deleted_at IS NULL`,
        [data.category_id],
      );
      if (existingCategories.length === 0) {
        const error = new Error("Category not found");
        error.status = 400;
        throw error;
      }

      // Insert new product
      const [result] = await connection.query(
        `INSERT INTO products (name, price, stock, min_stock, category_id, created_at, created_by)
                 VALUES (?, ?, ?, ?, ?, NOW(), ?)`,
        [
          data.name,
          data.price,
          data.stock,
          data.min_stock,
          data.category_id,
          data.created_by,
        ],
      );

      await connection.commit();

      // Get the full new state of the product for auditing
      const [newProductDataResult] = await connection.query(
        `SELECT * FROM products WHERE id = ?`,
        [result.insertId],
      );
      const newProductData = newProductDataResult[0];

      // Audit Log
      await auditLogService.log({
        userId: data.created_by,
        username: data.usernameToken,
        actionType: "CREATE",
        entityType: "product",
        entityId: result.insertId,
        changes: { newValue: newProductData },
        ipAddress: data.ipAddress,
      });

      return {
        message: "Product created successfully",
        data: { id: result.insertId, ...data },
      };
    } catch (error) {
      await connection.rollback();
      // Audit Log for failure
      await auditLogService.log({
        userId: data.created_by,
        username: data.usernameToken,
        actionType: "CREATE",
        entityType: "product",
        ipAddress: data.ipAddress,
        status: "FAILURE",
        errorMessage: error.message,
      });
      throw error;
    } finally {
      if (connection) connection.release();
    }
  }

  // Update an existing product - SINGLE CORRECT IMPLEMENTATION
  async putProduct(id, data) {
    let connection;
    let oldProductData = null;
    try {
      connection = await getConnection();
      await connection.beginTransaction();

      // 1. Check if product exists and get its old data for auditing
      const [existingProducts] = await connection.query(
        `SELECT * FROM products WHERE deleted_at IS NULL AND id = ?`,
        [id],
      );
      if (!existingProducts[0]) {
        const error = new Error("Product not found");
        error.status = 404;
        throw error;
      }
      const product = existingProducts[0];
      oldProductData = existingProducts[0];

      // 2. Check if category exists if it's being updated
      if (data.category_id) {
        const [existingCategories] = await connection.query(
          `SELECT id FROM product_categories WHERE id = ? AND deleted_at IS NULL`,
          [data.category_id],
        );
        if (existingCategories.length === 0) {
          const error = new Error("Category not found");
          error.status = 400;
          throw error;
        }
      }

      // 3. Update product
      await connection.query(
        `UPDATE products
                 SET name = ?, price = ?, stock = ?, min_stock = ?, category_id = ?, updated_by = ?, updated_at = NOW()
                 WHERE id = ?`,
        [
          data.name ?? product.name,
          data.price ?? product.price,
          data.stock ?? product.stock,
          data.min_stock ?? product.min_stock,
          data.category_id ?? product.category_id,
          data.updated_by,
          id,
        ],
      );

      await connection.commit();

      // Get the full new state of the product for auditing
      const [newProductDataResult] = await connection.query(
        `SELECT * FROM products WHERE id = ?`,
        [id],
      );
      const newProductData = newProductDataResult[0];

      // 4. Audit Log for success
      await auditLogService.log({
        userId: data.updated_by,
        username: data.usernameToken,
        actionType: "UPDATE",
        entityType: "product",
        entityId: id,
        changes: { oldValue: oldProductData, newValue: newProductData },
        ipAddress: data.ipAddress,
      });

      // 5. Return response
      return {
        message: "Product updated successfully",
        data: newProductData,
      };
    } catch (error) {
      await connection.rollback();
      // Audit Log for failure
      await auditLogService.log({
        userId: data.updated_by,
        username: data.usernameToken,
        actionType: "UPDATE",
        entityType: "product",
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

  async restoreProduct(id, data) {
    let connection;
    let oldProductData = null;
    try {
      connection = await getConnection();
      await connection.beginTransaction();

      // 1. Find the soft-deleted product
      const [products] = await connection.query(
        `SELECT * FROM products WHERE id = ? AND deleted_at IS NOT NULL`,
        [id],
      );

      if (!products[0]) {
        const error = new Error(
          "Inactive product not found or is already active.",
        );
        error.status = 404;
        throw error;
      }
      oldProductData = products[0];

      // 2. Restore the product
      await connection.query(
        `UPDATE products SET deleted_at = NULL, deleted_by = NULL, updated_at = NOW(), updated_by = ? WHERE id = ?`,
        [data.updated_by, id],
      );

      await connection.commit();

      // 3. Get the new state for auditing
      const [newProductDataResult] = await connection.query(
        `SELECT * FROM products WHERE id = ?`,
        [id],
      );
      const newProductData = newProductDataResult[0];

      // 4. Audit the restoration
      await auditLogService.log({
        userId: data.updated_by,
        username: data.usernameToken,
        actionType: "UPDATE",
        entityType: "product",
        entityId: id,
        changes: { oldValue: oldProductData, newValue: newProductData },
        ipAddress: data.ipAddress,
      });

      return {
        message: "Product restored successfully",
        data: { id: newProductData.id, name: newProductData.name },
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

  async deleteProduct(id, data) {
    let connection;
    let oldProductData = null;
    try {
      connection = await getConnection();
      await connection.beginTransaction();

      const [existingProducts] = await connection.query(
        `SELECT * FROM products WHERE deleted_at IS NULL AND id = ?`,
        [id],
      );
      const product = existingProducts[0];
      oldProductData = product; // Capture old data before any potential error
      if (!product) {
        const error = new Error("Product not found");
        error.status = 404;
        throw error;
      }

      // Soft delete
      await connection.query(
        `UPDATE products SET deleted_by = ?, deleted_at = NOW() WHERE id = ?`,
        [data.deleted_by, id],
      );

      await connection.commit();

      const deletedProductState = { ...oldProductData, deleted_at: new Date() };

      // Audit Log
      await auditLogService.log({
        userId: data.deleted_by,
        username: data.usernameToken,
        actionType: "DELETE",
        entityType: "product",
        entityId: id,
        changes: {
          oldValue: oldProductData,
          newValue: deletedProductState,
        },
        ipAddress: data.ipAddress,
      });

      return {
        message: "Product deleted successfully",
        data: { id, name: product.name },
      };
    } catch (error) {
      await connection.rollback();
      // Audit Log for failure
      await auditLogService.log({
        userId: data.deleted_by,
        username: data.usernameToken,
        actionType: "DELETE",
        entityType: "product",
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

  async putCategory(id, data) {
    let connection;
    let oldCategoryData = null;
    try {
      connection = await getConnection();
      await connection.beginTransaction();

      // 1. Check if the category to update exists
      const [existingCategory] = await connection.query(
        `SELECT * FROM product_categories WHERE id = ? AND deleted_at IS NULL`,
        [id],
      );

      if (existingCategory.length === 0) {
        const error = new Error("Category not found");
        error.status = 404;
        throw error;
      }
      oldCategoryData = existingCategory[0];

      // 2. Check for name conflict
      const [conflictCategory] = await connection.query(
        `SELECT id FROM product_categories WHERE name = ? AND id != ? AND deleted_at IS NULL`,
        [data.name, id],
      );

      if (conflictCategory.length > 0) {
        const error = new Error(
          "Another category with this name already exists.",
        );
        error.status = 409; // Conflict
        throw error;
      }

      // 3. Update the category
      await connection.query(
        `UPDATE product_categories SET name = ?, updated_at = NOW(), updated_by = ? WHERE id = ?`,
        [data.name, data.updated_by, id],
      );

      await connection.commit();

      // Get the full new state of the category for auditing
      const [newCategoryDataResult] = await connection.query(
        `SELECT * FROM product_categories WHERE id = ?`,
        [id],
      );
      const newCategoryData = newCategoryDataResult[0];

      // Audit Log for success
      await auditLogService.log({
        userId: data.updated_by,
        username: data.usernameToken,
        actionType: "UPDATE",
        entityType: "product_category",
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
        entityType: "product_category",
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

  async postCategory(data) {
    let connection;
    try {
      connection = await getConnection();
      await connection.beginTransaction();

      // 1. Check if a category with this name exists (active or soft-deleted)
      const [existingCategory] = await connection.query(
        `SELECT * FROM product_categories WHERE name = ?`,
        [data.name],
      );

      if (existingCategory.length > 0) {
        const category = existingCategory[0];
        if (category.deleted_at === null) {
          // 2. Category is active, throw conflict error
          const error = new Error("Category with this name already exists");
          error.status = 409; // 409 Conflict is more appropriate
          throw error;
        } else {
          // 2a. Category is soft-deleted, so we "undelete" it
          await connection.query(
            `UPDATE product_categories 
                         SET deleted_at = NULL, deleted_by = NULL, updated_at = NOW(), updated_by = ? 
                         WHERE id = ?`,
            [data.created_by, category.id],
          );
          await connection.commit();

          // Audit Log for RESTORE (as UPDATE)
          await auditLogService.log({
            userId: data.created_by,
            username: data.usernameToken,
            actionType: "UPDATE",
            entityType: "product_category",
            entityId: category.id,
            changes: {
              oldValue: category,
              newValue: { ...category, deleted_at: null, deleted_by: null },
            },
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
        `INSERT INTO product_categories (name, created_at, created_by)
                 VALUES (?, NOW(), ?)`,
        [data.name, data.created_by],
      );

      await connection.commit();

      // Audit Log for CREATE
      await auditLogService.log({
        userId: data.created_by,
        username: data.usernameToken,
        actionType: "CREATE",
        entityType: "product_category",
        entityId: insertResult.insertId,
        changes: { newValue: data },
        ipAddress: data.ipAddress,
      });
      return {
        message: "Category created successfully",
        data: { id: insertResult.insertId, ...data },
      };
    } catch (error) {
      await connection.rollback();
      // Audit Log for failure
      await auditLogService.log({
        userId: data.created_by,
        username: data.usernameToken,
        actionType: "CREATE",
        entityType: "product_category",
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

      // 1. Check if the category exists
      const [existingCategory] = await connection.query(
        `SELECT * FROM product_categories WHERE id = ? AND deleted_at IS NULL`,
        [id],
      );

      oldCategoryData = existingCategory[0];
      if (existingCategory.length === 0) {
        const error = new Error("Category not found");
        error.status = 404;
        throw error;
      }

      // 2. Check if any product is using this category
      const [productsUsingCategory] = await connection.query(
        `SELECT id FROM products WHERE category_id = ? AND deleted_at IS NULL`,
        [id],
      );

      if (productsUsingCategory.length > 0) {
        const error = new Error(
          "Cannot delete category because it is being used by one or more products.",
        );
        error.status = 409; // 409 Conflict is appropriate here
        throw error;
      }

      // 3. Soft delete the category
      await connection.query(
        `UPDATE product_categories SET deleted_at = NOW(), deleted_by = ? WHERE id = ?`,
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
        entityType: "product_category",
        entityId: id,
        changes: {
          oldValue: oldCategoryData,
          newValue: deletedCategoryState, // <-- CLAVE
        },
        ipAddress: data.ipAddress,
      });

      return { message: "Category deleted successfully" };
    } catch (error) {
      await connection.rollback();
      // Audit Log for failure
      await auditLogService.log({
        userId: data.deleted_by,
        username: data.usernameToken,
        actionType: "DELETE",
        entityType: "product_category",
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

  async restoreCategory(id, data) {
    let connection;
    let oldCategoryData = null;
    try {
      connection = await getConnection();
      await connection.beginTransaction();

      // 1. Find the soft-deleted category
      const [categories] = await connection.query(
        `SELECT * FROM product_categories WHERE id = ? AND deleted_at IS NOT NULL`,
        [id],
      );

      if (!categories[0]) {
        const error = new Error(
          "Inactive product category not found or is already active.",
        );
        error.status = 404;
        throw error;
      }
      oldCategoryData = categories[0];

      // 2. Restore the category
      await connection.query(
        `UPDATE product_categories SET deleted_at = NULL, deleted_by = NULL, updated_at = NOW(), updated_by = ? WHERE id = ?`,
        [data.updated_by, id],
      );

      await connection.commit();

      // 3. Get the new state for auditing
      const [newCategoryDataResult] = await connection.query(
        `SELECT * FROM product_categories WHERE id = ?`,
        [id],
      );
      const newCategoryData = newCategoryDataResult[0];

      // 4. Audit the restoration
      await auditLogService.log({
        userId: data.updated_by,
        username: data.usernameToken,
        actionType: "UPDATE",
        entityType: "product_category",
        entityId: id,
        ipAddress: data.ipAddres,
        changes: {
          oldValue: oldCategoryData,
          newValue: { ...newCategoryData, deleted_at: null },
        },
      });

      return {
        message: "Product category restored successfully",
        data: { id: newCategoryData.id, name: newCategoryData.name },
      };
    } catch (error) {
      if (connection) await connection.rollback();
      throw error;
    } finally {
      if (connection) connection.release();
    }
  }

  async getCategories(params = {}) {
    let connection;
    try {
      connection = await getConnection();
      const { status = "active" } = params;
      let query = `SELECT id, name FROM product_categories`;

      if (status === "active") query += " WHERE deleted_at IS NULL";
      else if (status === "inactive") query += " WHERE deleted_at IS NOT NULL";

      query += " ORDER BY name";

      const [categories] = await connection.query(query);
      return {
        message: "Categories retrieved successfully",
        data: categories,
      };
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
                FROM product_categories 
                WHERE deleted_at IS NULL AND id = ?
            `;
      const [categoryResult] = await connection.query(query, [id]);
      const category = categoryResult[0];

      if (!category) {
        const error = new Error("Category not found");
        error.status = 404;
        throw error;
      }

      return {
        message: "Category retrieved successfully",
        data: category,
      };
    } finally {
      if (connection) connection.release();
    }
  }
}

module.exports = ProductsService;
