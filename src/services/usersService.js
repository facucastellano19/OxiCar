const getConnection = require("../database/mysql");
const bcrypt = require("bcrypt");
const { sign } = require("../utils/jwt");
const auditLogService = require("./auditLogService");

class UsersService {
  async login(data) {
    let connection;
    try {
      connection = await getConnection();
      const query = `
                SELECT id, name, role_id, username, password 
                FROM users 
                WHERE username = ? AND deleted_at IS NULL 
                LIMIT 1
            `;

      const [users] = await connection.query(query, [data.username]);

      const actor = data.usernameToken || data.username;

      if (!users[0]) {
        // Audit Log for failed login (user not found)
        await auditLogService.log({
          actionType: "LOGIN_FAIL",
          username: actor,
          entityType: "user",
          status: "FAILURE",
          errorMessage: `Login attempt for non-existent user: ${data.username}`,
          ipAddress: data.ipAddress,
        });
        const error = new Error("User not found");
        error.status = 404;
        throw error;
      }

      const { id, name, username, role_id, password } = users[0];
      const isValid = await bcrypt.compare(data.password, password);

      if (!isValid) {
        // Audit Log for failed login (invalid password)
        await auditLogService.log({
          userId: id,
          username: actor,
          actionType: "LOGIN_FAIL",
          entityType: "user",
          entityId: id,
          ipAddress: data.ipAddress,
          status: "FAILURE",
          errorMessage: "Invalid credentials provided",
        });
        const error = new Error("Invalid credentials");
        error.status = 401;
        throw error;
      }

      const token = sign({ id, name, username, role_id }, { expiresIn: "1h" });

      // Audit Log for successful login
      await auditLogService.log({
        userId: id,
        username: data.usernameToken,
        actionType: "LOGIN_SUCCESS",
        entityType: "user",
        entityId: id,
        ipAddress: data.ipAddress,
      });
      return { login: true, token };
    } finally {
      if (connection) {
        connection.release();
      }
    }
  }

  async register(data) {
    let connection;
    try {
      connection = await getConnection();

      // 1. Check if a user with this username or email exists (active or soft-deleted)
      const [existingUsers] = await connection.query(
        "SELECT * FROM users WHERE username = ? OR email = ?",
        [data.username, data.email],
      );

      if (existingUsers.length > 0) {
        const user = existingUsers[0];
        if (user.deleted_at === null) {
          // 2. User is active, throw conflict error
          const error = new Error("Username or email already taken");
          error.status = 409;
          throw error;
        } else {
          // 2a. User is soft-deleted, so we "undelete" and update them
          const hashedPassword = await bcrypt.hash(data.password, 10);
          await connection.query(
            `UPDATE users SET 
                            name = ?, email = ?, username = ?, password = ?, 
                            deleted_at = NULL, deleted_by = NULL, 
                            updated_at = NOW(), updated_by = ? 
                         WHERE id = ?`,
            [
              data.name,
              data.email,
              data.username,
              hashedPassword,
              data.created_by,
              user.id,
            ],
          );

          // Audit Log for RESTORE (as UPDATE)
          const [restoredUserRows] = await connection.query(
            `SELECT id, name, email, username, role_id, created_at, created_by FROM users WHERE id = ?`,
            [user.id],
          );
          await auditLogService.log({
            userId: data.created_by,
            username: data.usernameToken,
            actionType: "UPDATE",
            entityType: "user",
            entityId: user.id,
            changes: { oldValue: user, newValue: restoredUserRows[0] },
            ipAddress: data.ipAddress,
          });

          return { ...restoredUserRows[0] };
        }
      }

      // 3. User does not exist, create a new one
      const hashedPassword = await bcrypt.hash(data.password, 10);
      const role_id = data.role_id || 2;
      const query = `
            INSERT INTO users (name, email, username, password, role_id, created_at, created_by)
            VALUES (?, ?, ?, ?, ?, NOW(), ?)
        `;
      const [result] = await connection.query(query, [
        data.name,
        data.email,
        data.username,
        hashedPassword,
        role_id,
        data.created_by,
      ]);

      // Get the full new state of the user for auditing (excluding password)
      const [newUserRows] = await connection.query(
        `SELECT id, name, email, username, role_id, created_at, created_by FROM users WHERE id = ?`,
        [result.insertId],
      );
      const newUserData = newUserRows[0];

      // Audit Log for successful registration
      await auditLogService.log({
        userId: data.created_by,
        username: data.usernameToken,
        actionType: "CREATE",
        entityType: "user",
        entityId: result.insertId,
        changes: { newValue: newUserData },
        ipAddress: data.ipAddress,
      });

      return {
        id: result.insertId,
        name: data.name,
        email: data.email,
        username: data.username,
        role_id: data.role_id,
        created_by: data.created_by,
      };
    } catch (error) {
      // Audit Log for failed registration
      await auditLogService.log({
        userId: data.created_by,
        username: data.usernameToken,
        actionType: "CREATE",
        entityType: "user",
        ipAddress: data.ipAddress,
        status: "FAILURE",
        errorMessage: error.message,
      });

      error.status = error.status || 500;
      error.message = "Error registering user: " + error.message;
      throw error;
    } finally {
      if (connection) {
        connection.release();
      }
    }
  }

  async isFirstUser() {
    let connection;
    try {
      connection = await getConnection();
      const [rows] = await connection.query(
        "SELECT COUNT(*) AS count FROM users",
      );
      return rows[0].count === 0;
    } catch (error) {
      console.error("Error checking if is first user:", error);
      return false;
    } finally {
      if (connection) {
        connection.release();
      }
    }
  }
}

module.exports = UsersService;
