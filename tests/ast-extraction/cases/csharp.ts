export const CS_COMPLEX_CODE = `
namespace Enterprise.Billing
{
    public interface IInvoiceGenerator
    {
        Task<string> GenerateAsync(long accountId);
    }

    public class InvoiceService : IInvoiceGenerator
    {
        public async Task<string> GenerateAsync(long accountId)
        {
            return "INV-" + accountId;
        }
    }
}
`;
