// C# fixture: enterprise service with multiple classes and async patterns.
namespace Enterprise.Billing
{
    using System;
    using System.Collections.Generic;
    using System.Threading.Tasks;

    public interface IInvoiceGenerator
    {
        Task<string> GenerateAsync(long accountId);
    }

    public class InvoiceRecord
    {
        public long Id { get; set; }
        public string AccountName { get; set; } = string.Empty;
        public decimal Total { get; set; }
        public DateTime CreatedAt { get; set; }
    }

    public class InvoiceService : IInvoiceGenerator
    {
        private readonly Dictionary<long, InvoiceRecord> store = new();

        public async Task<string> GenerateAsync(long accountId)
        {
            if (accountId <= 0) throw new ArgumentOutOfRangeException(nameof(accountId));
            var record = new InvoiceRecord
            {
                Id = accountId,
                AccountName = $"Account-{accountId}",
                Total = 0m,
                CreatedAt = DateTime.UtcNow,
            };
            store[accountId] = record;
            return "INV-" + accountId;
        }

        public InvoiceRecord? FindById(long id) => store.TryGetValue(id, out var r) ? r : null;

        public void MarkPaid(long id, decimal amount)
        {
            if (store.TryGetValue(id, out var r))
            {
                r.Total = amount;
            }
        }
    }
}
