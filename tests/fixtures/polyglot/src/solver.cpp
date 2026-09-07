// C++ fixture: real geometry solver with templates, exceptions, and operator overloading.
#include <string>
#include <vector>
#include <stdexcept>
#include <cmath>

class Matrix {
public:
    std::vector<std::vector<double>> data;

    Matrix(int rows, int cols) : data(rows, std::vector<double>(cols, 0.0)) {}

    double& at(int r, int c) {
        if (r < 0 || c < 0 || r >= (int)data.size() || c >= (int)data[0].size()) {
            throw std::out_of_range("Matrix index out of range");
        }
        return data[r][c];
    }
};

class GeometrySolver {
public:
    double calculate_hypotenuse(double a, double b) {
        if (a < 0.0 || b < 0.0) throw std::invalid_argument("sides must be non-negative");
        return std::sqrt(a * a + b * b);
    }

    double dot_product(const std::vector<double>& a, const std::vector<double>& b) {
        if (a.size() != b.size()) throw std::invalid_argument("size mismatch");
        double s = 0.0;
        for (size_t i = 0; i < a.size(); ++i) s += a[i] * b[i];
        return s;
    }

    std::vector<double> matrix_vector_multiply(const Matrix& m, const std::vector<double>& v) {
        if (m.data.empty() || (int)v.size() != (int)m.data[0].size()) {
            throw std::invalid_argument("shape mismatch");
        }
        std::vector<double> out(m.data.size(), 0.0);
        for (size_t i = 0; i < m.data.size(); ++i) {
            for (size_t j = 0; j < v.size(); ++j) {
                out[i] += m.data[i][j] * v[j];
            }
        }
        return out;
    }
};
