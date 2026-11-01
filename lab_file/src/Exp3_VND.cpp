// 3-SAT using Variable Neighbourhood Descent (VND)
// F = (b v c') ^ (c v d') ^ (b') ^ (a' v e') ^ (c' v e) ^ (c' v d')
#include <iostream>
#include <vector>
using namespace std;

const int N = 5;                         // variables a b c d e
const char var[N] = {'a', 'b', 'c', 'd', 'e'};

// h(x) = number of clauses satisfied by assignment x  (max = 6)
int h(const vector<int> &x) {
    int a = x[0], b = x[1], c = x[2], d = x[3], e = x[4];
    int sat = 0;
    sat += (b || !c);
    sat += (c || !d);
    sat += (!b);
    sat += (!a || !e);
    sat += (!c || e);
    sat += (!c || !d);
    return sat;
}

void show(const vector<int> &x) {
    for (int i = 0; i < N; i++) cout << var[i] << "=" << x[i] << " ";
    cout << " h = " << h(x);
}

// Best neighbour inside neighbourhood N_k (all ways of flipping k bits)
vector<int> bestInNk(const vector<int> &x, int k) {
    vector<int> best = x;
    for (int mask = 1; mask < (1 << N); mask++) {
        if (__builtin_popcount(mask) != k) continue;
        vector<int> y = x;
        for (int i = 0; i < N; i++)
            if (mask & (1 << i)) y[i] = !y[i];
        if (h(y) > h(best)) best = y;
    }
    return best;
}

int main() {
    vector<int> x = {1, 1, 1, 1, 1};
    cout << "Start  : "; show(x); cout << "\n\n";
    int k = 1, step = 0;
    while (k <= N && h(x) < 6) {
        vector<int> y = bestInNk(x, k);
        if (h(y) > h(x)) {
            x = y;
            cout << "Step " << ++step << " (N" << k << ") : ";
            show(x);
            cout << "\n";
            k = 1;                       // improvement -> back to N1
        } else {
            cout << "  N" << k << " gives no better neighbour, try N"
                 << k + 1 << "\n";
            k++;                         // try a larger neighbourhood
        }
    }
    cout << "\nResult : "; show(x);
    cout << (h(x) == 6 ? "\nAll 6 clauses satisfied -> F is SATISFIABLE\n"
                       : "\nLocal optimum reached\n");
    return 0;
}
