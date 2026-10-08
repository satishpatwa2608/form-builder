import { useNavigate, useParams } from 'react-router-dom';
import BuilderPage from '../form/pages/BuilderPage';

/** The ported Sangam builder, full screen: back goes to the Forms list; new versions open in place. */
export default function BuilderRoute() {
  const { id } = useParams();
  const navigate = useNavigate();
  return <BuilderPage formId={id} onBack={() => navigate('/forms')} onOpenForm={(next) => navigate(`/forms/${next}/edit`)} />;
}
